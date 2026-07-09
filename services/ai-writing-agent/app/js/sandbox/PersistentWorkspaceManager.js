import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { ObjectId, db } from '../mongodb.js'
import { getAgentRuntimeConfig } from '../RuntimeConfigManager.js'
import {
  SandboxSessionDisabledError,
  SandboxSessionInputError,
} from './SandboxSessionManager.js'
import { SandboxNotFoundError } from './SandboxErrors.js'

const PROJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const USER_ID_RE = /^[0-9a-fA-F]{24}$/
const ACTIVE_STATUSES = ['active', 'ready']

function generateWorkspaceId() {
  return `workspace-${crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex')}`
}

async function createDefaultProvider(config) {
  if (config.sandbox.provider === 'local-docker') {
    const { LocalDockerSandboxProvider } = await import(
      './LocalDockerSandboxProvider.js'
    )
    return new LocalDockerSandboxProvider({
      image: config.sandbox.image,
      rootDir: config.sandbox.rootDir,
      dockerRootDir: config.sandbox.dockerRootDir,
      timeoutMs: config.sandbox.commandTimeoutMs,
      maxOutputBytes: config.sandbox.maxOutputBytes,
      maxArtifactBytes: config.sandbox.maxArtifactBytes,
      maxFileCount: config.sandbox.maxFileCount,
      networkPolicy: config.sandbox.networkPolicy,
      memoryBytes: config.sandbox.memoryBytes,
      memorySwapBytes: config.sandbox.memorySwapBytes,
      cpuCount: config.sandbox.cpuCount,
      pidsLimit: config.sandbox.pidsLimit,
    })
  }

  if (config.sandbox.provider === 'e2b') {
    const { E2BSandboxProvider } = await import('./E2BSandboxProvider.js')
    return new E2BSandboxProvider({
      template: config.sandbox.e2bTemplate,
      apiKey: config.sandbox.e2bApiKey,
      timeoutMs: config.sandbox.commandTimeoutMs,
      maxOutputBytes: config.sandbox.maxOutputBytes,
      maxArtifactBytes: config.sandbox.maxArtifactBytes,
      maxFileCount: config.sandbox.maxFileCount,
    })
  }

  throw new SandboxSessionInputError(
    `Unsupported sandbox provider: ${config.sandbox.provider}`
  )
}

async function createDefaultExporter() {
  const { ProjectAdapter } = await import('../adapter/ProjectAdapter.js')
  const { DocumentAdapter } = await import('../adapter/DocumentAdapter.js')
  const { FileStoreAdapter } = await import('../adapter/FileStoreAdapter.js')
  const { ProjectSnapshotExporter } = await import(
    './ProjectSnapshotExporter.js'
  )
  return new ProjectSnapshotExporter({
    projectAdapter: new ProjectAdapter(),
    documentAdapter: new DocumentAdapter(),
    fileStoreAdapter: new FileStoreAdapter(),
  })
}

async function createDefaultProjectAdapter() {
  const { ProjectAdapter } = await import('../adapter/ProjectAdapter.js')
  return new ProjectAdapter()
}

async function createDefaultDocumentAdapter() {
  const { DocumentAdapter } = await import('../adapter/DocumentAdapter.js')
  return new DocumentAdapter()
}

async function createDefaultDiffCollector() {
  const { ProjectDiffCollector } = await import('./ProjectDiffCollector.js')
  return new ProjectDiffCollector()
}

async function createDefaultPatchConverter() {
  const { PatchToPendingChanges } = await import('./PatchToPendingChanges.js')
  return new PatchToPendingChanges()
}

export class PersistentWorkspaceDriftError extends Error {
  constructor(drift) {
    super('Overleaf project changed since workspace export')
    this.name = 'PersistentWorkspaceDriftError'
    this.code = 'WORKSPACE_DRIFT_DETECTED'
    this.statusCode = 409
    this.drift = drift
  }
}

export class PersistentWorkspaceManager {
  constructor(options = {}) {
    this.getRuntimeConfig = options.getRuntimeConfig || getAgentRuntimeConfig
    this.provider = options.provider
    this.exporter = options.exporter
    this.projectAdapter = options.projectAdapter
    this.documentAdapter = options.documentAdapter
    this.diffCollector = options.diffCollector
    this.patchConverter = options.patchConverter
    this.workspacesCollection =
      options.workspacesCollection || db.aiAgentWorkspaces
    this.sessionsCollection = options.sessionsCollection || db.aiSessions
    this.logger = options.logger || logger
    this.now = options.now || (() => new Date())
    this.generateWorkspaceId =
      options.generateWorkspaceId || generateWorkspaceId
    this.activeProviders = options.activeProviders || new Map()
  }

  async ensureWorkspace(input = {}) {
    const config = this.getRuntimeConfig()
    if (!config.sandboxEnabled && !config.agentLoopV2Enabled) {
      throw new SandboxSessionDisabledError()
    }

    const sessionId = this.validateSessionId(input.sessionId)
    const projectId = this.validateObjectId(input.projectId, 'projectId')
    const userId = this.validateObjectId(input.userId, 'userId')

    const existing = await this.findReusableWorkspace({
      sessionId,
      projectId,
      userId,
    })
    if (existing) {
      const drift = await this.detectDrift(existing)
      await this.touchWorkspace(existing._id, drift)
      if (input.failOnDrift && drift.hasDrift) {
        throw new PersistentWorkspaceDriftError(drift)
      }
      let sandboxSession
      try {
        sandboxSession = await this.resumeProviderSession(existing, config)
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError || error.code === 'SANDBOX_NOT_FOUND')) {
          throw error
        }
        await this.retireMissingWorkspace(existing)
        return this.createWorkspace({ sessionId, projectId, userId, config })
      }
      return {
        workspace: existing,
        sandboxSession,
        created: false,
        drift,
      }
    }

    return this.createWorkspace({ sessionId, projectId, userId, config })
  }

  async retireMissingWorkspace(workspace) {
    await this.workspacesCollection.updateOne(
      { _id: workspace._id },
      {
        $set: {
          status: 'expired',
          errorCode: 'SANDBOX_NOT_FOUND',
          updatedAt: this.now(),
        },
      }
    )
    await this.sessionsCollection.updateOne(
      { _id: new ObjectId(workspace.sessionId) },
      {
        $unset: {
          workspaceId: '',
          workspaceStatus: '',
          workspaceUpdatedAt: '',
        },
      }
    )
    this.activeProviders.delete(workspace._id)
  }

  async createWorkspace({ sessionId, projectId, userId, config }) {
    const workspaceId = this.generateWorkspaceId()
    const provider = this.provider || (await createDefaultProvider(config))
    const exporter = this.exporter || (await createDefaultExporter())
    const createdAt = this.now()
    const expiresAt = new Date(
      createdAt.getTime() + (config.sandbox.workspaceTtlMs || 86400000)
    )

    await this.workspacesCollection.insertOne({
      _id: workspaceId,
      sessionId,
      projectId,
      userId,
      provider: config.sandbox.provider,
      status: 'starting',
      createdAt,
      updatedAt: createdAt,
      lastUsedAt: createdAt,
      expiresAt,
    })

    let sandboxSession
    try {
      sandboxSession = await provider.createSession({
        id: workspaceId,
        projectId,
        userId,
        config: config.sandbox,
      })
      const manifest = await exporter.exportProject(
        projectId,
        sandboxSession.workspacePath,
        { userId, sessionId }
      )
      this.activeProviders.set(workspaceId, provider)

      const workspaceUpdate = {
        status: 'ready',
        providerSessionId: sandboxSession.id,
        workspacePath: sandboxSession.workspacePath,
        manifest,
        manifestExportedAt: this.now(),
        updatedAt: this.now(),
        lastUsedAt: this.now(),
      }
      await this.workspacesCollection.updateOne(
        { _id: workspaceId },
        { $set: workspaceUpdate }
      )
      await this.sessionsCollection.updateOne(
        { _id: new ObjectId(sessionId) },
        {
          $set: {
            workspaceId,
            workspaceStatus: 'ready',
            workspaceUpdatedAt: this.now(),
          },
        }
      )

      return {
        workspace: {
          _id: workspaceId,
          sessionId,
          projectId,
          userId,
          provider: config.sandbox.provider,
          ...workspaceUpdate,
          createdAt,
          expiresAt,
        },
        sandboxSession,
        created: true,
        drift: { hasDrift: false, changes: [] },
      }
    } catch (error) {
      await this.workspacesCollection.updateOne(
        { _id: workspaceId },
        {
          $set: {
            status: 'failed',
            errorCode: error.code || 'WORKSPACE_CREATE_FAILED',
            updatedAt: this.now(),
          },
        }
      )
      if (sandboxSession?.id) {
        await provider.destroySession?.(sandboxSession.id).catch((err) => {
          this.logger.warn(
            { err, workspaceId },
            'failed to destroy sandbox after workspace creation failure'
          )
        })
      }
      throw error
    }
  }

  async findReusableWorkspace({ sessionId, projectId, userId }) {
    const workspace = await this.workspacesCollection.findOne({
      sessionId,
      projectId,
      userId,
      status: { $in: ACTIVE_STATUSES },
      expiresAt: { $gt: this.now() },
    })
    return workspace || null
  }

  async resumeProviderSession(workspace, config) {
    let provider = this.activeProviders.get(workspace._id)
    if (!provider) {
      provider = this.provider || (await createDefaultProvider(config))
      this.activeProviders.set(workspace._id, provider)
    }
    return provider.resumeSession(workspace.providerSessionId || workspace._id, {
      workspacePath: workspace.workspacePath,
      containerName: workspace.containerName,
      providerSessionId: workspace.providerSessionId,
    })
  }

  async detectDrift(workspace) {
    const manifest = workspace.manifest
    if (!manifest?.files?.length) {
      return { hasDrift: false, changes: [] }
    }

    const projectAdapter =
      this.projectAdapter || (await createDefaultProjectAdapter())
    const documentAdapter =
      this.documentAdapter || (await createDefaultDocumentAdapter())
    const entities = await projectAdapter.getEntities(workspace.projectId)
    const docsById = new Map((entities.docs || []).map(doc => [doc.id, doc]))
    const changes = []

    for (const file of manifest.files) {
      if (file.entityType !== 'doc') continue
      const currentDoc = docsById.get(file.entityId)
      if (!currentDoc) {
        changes.push({
          type: 'deleted',
          path: file.path,
          entityId: file.entityId,
          baseVersion: file.baseVersion,
        })
        continue
      }
      const current = await documentAdapter.getDocumentContent(
        workspace.projectId,
        file.entityId
      )
      if (
        Number.isFinite(file.baseVersion) &&
        Number.isFinite(current.version) &&
        current.version !== file.baseVersion
      ) {
        changes.push({
          type: 'version-mismatch',
          path: file.path,
          entityId: file.entityId,
          baseVersion: file.baseVersion,
          currentVersion: current.version,
        })
      }
    }

    return { hasDrift: changes.length > 0, changes }
  }

  async touchWorkspace(workspaceId, drift) {
    const now = this.now()
    await this.workspacesCollection.updateOne(
      { _id: workspaceId },
      {
        $set: {
          lastUsedAt: now,
          updatedAt: now,
          lastDrift: drift,
        },
      }
    )
  }

  async cleanupExpired(options = {}) {
    const now = this.now()
    const query = options.includeActive
      ? { expiresAt: { $lte: now } }
      : { expiresAt: { $lte: now }, status: { $nin: ['running'] } }
    const expired = await this.workspacesCollection.find(query).toArray()
    const removed = []

    for (const workspace of expired) {
      const provider = await this.resolveCleanupProvider(workspace)
      const providerSessionId = workspace.providerSessionId || workspace._id
      if (provider?.destroySession && providerSessionId) {
        await provider
          .destroySession(providerSessionId, {
            workspacePath: workspace.workspacePath,
            containerName: workspace.containerName,
            providerSessionId: workspace.providerSessionId,
          })
          .catch((err) => {
            this.logger.warn(
              { err, workspaceId: workspace._id },
              'failed to destroy expired persistent workspace'
            )
          })
      }
      this.activeProviders.delete(workspace._id)
      await this.workspacesCollection.updateOne(
        { _id: workspace._id },
        {
          $set: {
            status: 'expired',
            expiredAt: now,
            updatedAt: now,
          },
        }
      )
      await this.sessionsCollection.updateOne(
        { _id: new ObjectId(workspace.sessionId), workspaceId: workspace._id },
        {
          $set: {
            workspaceStatus: 'expired',
            workspaceUpdatedAt: now,
          },
          $unset: { workspaceId: '' },
        }
      ).catch(() => {})
      removed.push(workspace._id)
    }

    return { removedWorkspaces: removed }
  }

  async syncPendingChanges(input = {}) {
    const config = this.getRuntimeConfig()
    const sessionId = this.validateSessionId(input.sessionId)
    const projectId = this.validateObjectId(input.projectId, 'projectId')
    const userId = this.validateObjectId(input.userId, 'userId')
    const workspace =
      input.workspace ||
      await this.findReusableWorkspace({ sessionId, projectId, userId })

    if (!workspace) {
      throw new SandboxSessionInputError('Persistent workspace not found')
    }
    this.assertWorkspaceOwnership(workspace, { sessionId, projectId, userId })
    if (!workspace.manifest?.files) {
      throw new SandboxSessionInputError('Workspace manifest is missing')
    }

    const drift = await this.detectDrift(workspace)
    await this.touchWorkspace(workspace._id, drift)
    if (input.failOnDrift !== false && drift.hasDrift) {
      throw new PersistentWorkspaceDriftError(drift)
    }

    await this.resumeProviderSession(workspace, config)
    const diffCollector =
      this.diffCollector || (await createDefaultDiffCollector())
    const patchConverter =
      this.patchConverter || (await createDefaultPatchConverter())
    const diff = await diffCollector.collect(
      workspace.workspacePath,
      workspace.manifest
    )
    const pendingChanges = patchConverter.convert(diff, workspace.manifest, {
      projectId,
      source: 'persistent-workspace',
    }).map(change => ({
      ...change,
      source: change.source || 'persistent-workspace',
      workspaceId: workspace._id,
      sandboxSessionId: workspace.providerSessionId || workspace._id,
    }))
    const changeCount = countDiffChanges(diff)
    const now = this.now()
    const session = await this.sessionsCollection.findOne({
      _id: new ObjectId(sessionId),
      projectId,
      userId,
    })
    const mergedPendingChanges = mergePendingChanges({
      existing: session?.pendingChanges,
      replacement: pendingChanges,
      workspaceId: workspace._id,
      source: 'persistent-workspace',
    })

    await this.sessionsCollection.updateOne(
      { _id: new ObjectId(sessionId), projectId, userId },
      {
        $set: {
          pendingChanges: mergedPendingChanges,
          workspaceStatus: changeCount > 0 ? 'pending-review' : 'clean',
          workspaceUpdatedAt: now,
          updatedAt: now,
        },
      }
    )
    await this.workspacesCollection.updateOne(
      { _id: workspace._id },
      {
        $set: {
          lastDiff: diff,
          lastPendingChangeCount: pendingChanges.length,
          lastSyncedAt: now,
          updatedAt: now,
        },
      }
    )

    return {
      workspace,
      drift,
      diff,
      pendingChanges,
      allPendingChanges: mergedPendingChanges,
      changeCount,
    }
  }

  async resolveCleanupProvider(workspace) {
    if (this.activeProviders.has(workspace._id)) {
      return this.activeProviders.get(workspace._id)
    }
    if (this.provider) return this.provider
    try {
      const config = this.getRuntimeConfig()
      return await createDefaultProvider({
        ...config,
        sandbox: {
          ...config.sandbox,
          provider: workspace.provider || config.sandbox.provider,
        },
      })
    } catch (err) {
      this.logger.warn(
        { err, workspaceId: workspace._id, provider: workspace.provider },
        'failed to create provider for expired persistent workspace cleanup'
      )
      return null
    }
  }

  validateSessionId(value) {
    if (typeof value !== 'string' || !PROJECT_ID_RE.test(value)) {
      throw new SandboxSessionInputError('Invalid sessionId')
    }
    return value
  }

  validateObjectId(value, field) {
    const pattern = field === 'userId' ? USER_ID_RE : PROJECT_ID_RE
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new SandboxSessionInputError(`Invalid ${field}`)
    }
    return value
  }

  assertWorkspaceOwnership(workspace, { sessionId, projectId, userId }) {
    if (
      workspace.sessionId !== sessionId ||
      workspace.projectId !== projectId ||
      workspace.userId !== userId
    ) {
      throw new SandboxSessionInputError(
        'Persistent workspace does not belong to this session, project, and user'
      )
    }
  }
}

function countDiffChanges(diff) {
  return (
    (diff.created?.length || 0) +
    (diff.modified?.length || 0) +
    (diff.deleted?.length || 0) +
    (diff.binaryChanged?.length || 0)
  )
}

function mergePendingChanges({ existing, replacement, workspaceId, source }) {
  const existingChanges = Array.isArray(existing) ? existing : []
  const next = existingChanges.filter(change => {
    return !(change?.workspaceId === workspaceId && change?.source === source)
  })
  next.push(...replacement)
  return next
}

export default PersistentWorkspaceManager
