import { expressify } from '@overleaf/promise-utils'
import logger from '@overleaf/logger'
import {
  SandboxSessionDisabledError,
  SandboxSessionInputError,
  SandboxSessionManager,
} from './sandbox/SandboxSessionManager.js'
import { PersistentWorkspaceManager } from './sandbox/PersistentWorkspaceManager.js'
import { ObjectId, db } from './mongodb.js'
import { DocumentAdapter } from './adapter/DocumentAdapter.js'
import { ProjectAdapter } from './adapter/ProjectAdapter.js'
import { getAgentRuntimeConfig } from './RuntimeConfigManager.js'
import { LocalDockerSandboxProvider } from './sandbox/LocalDockerSandboxProvider.js'

const INTERNAL_ERROR_CODE = 'SANDBOX_SESSION_FAILED'
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function safeError(error) {
  if (error instanceof SandboxSessionDisabledError) {
    return {
      status: error.statusCode,
      body: {
        error: 'Sandbox runtime is not enabled',
        code: error.code,
      },
    }
  }
  if (error instanceof SandboxSessionInputError) {
    return {
      status: error.statusCode,
      body: {
        error: error.message,
        code: error.code,
      },
    }
  }
  return {
    status: 500,
    body: {
      error: 'Sandbox session failed',
      code: error?.code || INTERNAL_ERROR_CODE,
    },
  }
}

export class SandboxAgentController {
  constructor(options = {}) {
    this.manager = options.manager || new SandboxSessionManager(options)
    this.logger = options.logger || logger
    this.sessionsCollection = options.sessionsCollection || db.aiSandboxSessions
    this.workspacesCollection =
      options.workspacesCollection || db.aiAgentWorkspaces
    this.workspaceManager =
      options.workspaceManager || new PersistentWorkspaceManager(options)
    this.artifactsCollection =
      options.artifactsCollection || db.aiSandboxArtifacts
    this.documentAdapter = options.documentAdapter || new DocumentAdapter()
    this.projectAdapter = options.projectAdapter || new ProjectAdapter()
    this.getRuntimeConfig = options.getRuntimeConfig || getAgentRuntimeConfig
    this.LocalDockerSandboxProvider =
      options.LocalDockerSandboxProvider || LocalDockerSandboxProvider
  }

  createWorkspace = async (req, res) => {
    const authorized = await this.loadAuthorizedWorkspaceSession(req, res)
    if (!authorized) return null
    const result = await this.workspaceManager.ensureWorkspace({
      sessionId: authorized.sessionId,
      projectId: authorized.projectId,
      userId: authorized.userId,
      failOnDrift: req.body?.failOnDrift === true,
    })
    return res.status(result.created ? 201 : 200).json({
      workspace: serializeWorkspace(result.workspace),
      created: result.created,
      drift: result.drift,
    })
  }

  getWorkspace = async (req, res) => {
    const workspace = await this.workspacesCollection.findOne({
      _id: req.params.workspaceId,
    })
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' })
    }
    if (workspace.userId !== req.headers['x-user-id']) {
      return res.status(403).json({ error: 'Access denied' })
    }
    return res.json({ workspace: serializeWorkspace(workspace) })
  }

  cleanupExpiredWorkspaces = async (_req, res) => {
    const result = await this.workspaceManager.cleanupExpired()
    return res.json(result)
  }

  cleanupSandbox = async (req, res) => {
    const includeActive = req.body?.includeActive === true
    const removeWorkspaces = req.body?.removeWorkspaces !== false
    const expiredWorkspaces = await this.workspaceManager.cleanupExpired({
      includeActive,
    })
    const config = this.getRuntimeConfig()
    let orphanCleanup = {
      skipped: true,
      reason: 'sandbox-disabled-or-non-local-provider',
    }

    if (
      (config.sandboxEnabled || config.agentLoopV2Enabled) &&
      config.sandbox?.provider === 'local-docker'
    ) {
      const provider = new this.LocalDockerSandboxProvider({
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
      orphanCleanup = {
        skipped: false,
        ...(await provider.manualCleanup({ includeActive, removeWorkspaces })),
      }
    }

    return res.json({
      includeActive,
      removeWorkspaces,
      expiredWorkspaces,
      orphanCleanup,
    })
  }

  startSession = async (req, res) => {
    const input = {
      projectId: req.body?.projectId,
      prompt: req.body?.prompt,
      profile: req.body?.profile,
      credentials: req.body?.credentials,
      userId: req.headers['x-user-id'],
    }

    if (req.headers.accept?.includes('text/event-stream')) {
      return this.streamSession(input, res)
    }

    const events = []
    try {
      for await (const event of this.manager.startSession(input)) {
        events.push(event)
      }
      return res.status(201).json({ events })
    } catch (error) {
      const response = safeError(error)
      if (response.status >= 500) {
        this.logger.warn({ err: error }, 'sandbox session request failed')
      }
      return res.status(response.status).json(response.body)
    }
  }

  async streamSession(input, res) {
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    try {
      for await (const event of this.manager.startSession(input)) {
        writeSse(res, event)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      const response = safeError(error)
      if (response.status >= 500) {
        this.logger.warn({ err: error }, 'sandbox session stream failed')
      }
      writeSse(res, { type: 'error', ...response.body })
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }

  acceptChange = async (req, res) => {
    const session = await this.loadAuthorizedSession(req, res)
    if (!session) return

    const change = findPendingChange(session, req.params.changeId)
    if (!change) {
      return res.status(404).json({ error: 'Change not found' })
    }
    if (change.status !== 'pending') {
      return res
        .status(409)
        .json({ error: `Change is already ${change.status}` })
    }
    if (change.type === 'artifact') {
      return res.status(400).json({
        error: 'Artifact-only sandbox changes cannot be applied automatically',
      })
    }

    try {
      const result = await this.applyChange(change, session.userId)
      await this.updateChangeStatus(session._id, change.id, {
        status: 'accepted',
        acceptedAt: new Date(),
        appliedVersion: result.newVersion,
        wasRebased: result.wasRebased,
      })
      res.json({
        success: true,
        change: {
          ...change,
          status: 'accepted',
          appliedVersion: result.newVersion,
          wasRebased: result.wasRebased,
        },
      })
    } catch (error) {
      await this.updateChangeStatus(session._id, change.id, {
        status: 'conflict',
        conflictAt: new Date(),
        conflictMessage: error.message,
        conflictType: error.info?.conflictType || error.code || 'UNKNOWN',
      }).catch(() => {})
      return res.status(409).json({
        success: false,
        error: 'SANDBOX_CHANGE_CONFLICT',
        message: error.message,
        conflictType: error.info?.conflictType || error.code,
      })
    }
  }

  rejectChange = async (req, res) => {
    const session = await this.loadAuthorizedSession(req, res)
    if (!session) return

    const change = findPendingChange(session, req.params.changeId)
    if (!change) {
      return res.status(404).json({ error: 'Change not found' })
    }
    if (!['pending', 'conflict'].includes(change.status)) {
      return res
        .status(409)
        .json({ error: `Cannot reject change with status: ${change.status}` })
    }

    await this.updateChangeStatus(session._id, change.id, {
      status: 'rejected',
      rejectedAt: new Date(),
      ...(req.body?.reason ? { rejectReason: req.body.reason } : {}),
    })
    res.json({ success: true, change: { ...change, status: 'rejected' } })
  }

  stopSession = async (req, res) => {
    const session = await this.loadAuthorizedSession(req, res)
    if (!session) return

    const result = await this.manager.stopSession?.(
      session._id,
      req.headers['x-user-id']
    )
    if (!result) {
      return res.status(501).json({ error: 'Sandbox stop is not supported' })
    }
    return res.json({ success: true, ...result })
  }

  getArtifact = async (req, res) => {
    const session = await this.loadAuthorizedSession(req, res)
    if (!session) return

    const artifact = await this.artifactsCollection.findOne({
      _id: req.params.artifactId,
      sessionId: session._id,
    })
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' })
    }

    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${basename(artifact.path)}"`
    )
    res.send(toBuffer(artifact.content))
  }

  async loadAuthorizedSession(req, res) {
    const sessionId = req.params.sandboxSessionId
    const userId = req.headers['x-user-id']
    const session = await this.sessionsCollection.findOne({ _id: sessionId })
    if (!session) {
      res.status(404).json({ error: 'Sandbox session not found' })
      return null
    }
    if (session.userId !== userId) {
      res.status(403).json({ error: 'Access denied' })
      return null
    }
    return session
  }

  async loadAuthorizedWorkspaceSession(req, res) {
    const sessionId = req.body?.sessionId
    const projectId = req.body?.projectId
    const userId = req.headers['x-user-id']
    if (!sessionId || !projectId) {
      res.status(400).json({ error: 'sessionId and projectId are required' })
      return null
    }
    if (!OBJECT_ID_RE.test(sessionId) || !OBJECT_ID_RE.test(projectId)) {
      res.status(400).json({ error: 'Invalid sessionId or projectId format' })
      return null
    }
    const sessionsCollection =
      this.workspaceManager.sessionsCollection || this.sessionsCollection
    const session = await sessionsCollection.findOne({
      _id: new ObjectId(sessionId),
    })
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return null
    }
    if (session.userId !== userId) {
      res.status(403).json({ error: 'Access denied' })
      return null
    }
    if (session.projectId !== projectId) {
      res.status(409).json({ error: 'Session project mismatch' })
      return null
    }
    return { sessionId, projectId, userId }
  }

  async applyChange(change, userId) {
    if (change.type === 'edit') {
      return this.documentAdapter.applyEdit(change, { userId })
    }
    if (change.type === 'create') {
      return this.applyCreateChange(change, userId)
    }
    if (change.type === 'delete') {
      return this.applyDeleteChange(change, userId)
    }
    throw new SandboxSessionInputError(
      `Unsupported sandbox change type: ${change.type}`
    )
  }

  async applyCreateChange(change, userId) {
    const dirPath = dirname(change.path)
    const fileName = basename(change.path)
    let parentFolderId = null
    if (dirPath && dirPath !== '/' && dirPath !== '.') {
      const folderResult = await this.projectAdapter.ensureFolderPath(
        change.projectId,
        dirPath,
        userId
      )
      parentFolderId = folderResult.folderId
    }

    const doc = await this.projectAdapter.createDoc(
      change.projectId,
      fileName,
      parentFolderId,
      userId
    )
    if (change.content) {
      try {
        await this.documentAdapter._callSetDocAPI(
          change.projectId,
          doc._id,
          change.content.split('\n'),
          userId,
          0
        )
      } catch (error) {
        await this.projectAdapter
          .deleteEntity(change.projectId, doc._id, 'doc', userId)
          .catch(() => {})
        throw error
      }
    }
    this.projectAdapter.clearCache?.(change.projectId)
    return { success: true, newVersion: 1, wasRebased: false }
  }

  async applyDeleteChange(change, userId) {
    await this.projectAdapter.deleteEntity(
      change.projectId,
      change.entityId,
      change.entityType,
      userId
    )
    this.projectAdapter.clearCache?.(change.projectId)
    return { success: true, newVersion: 0, wasRebased: false }
  }

  async updateChangeStatus(sessionId, changeId, fields) {
    await this.sessionsCollection.updateOne(
      {
        _id: sessionId,
        pendingChanges: { $elemMatch: { id: changeId } },
      },
      {
        $set: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            `pendingChanges.$.${key}`,
            value,
          ])
        ),
      }
    )
  }
}

const controller = new SandboxAgentController()

export default {
  startSession: expressify(controller.startSession),
  stopSession: expressify(controller.stopSession),
  acceptChange: expressify(controller.acceptChange),
  rejectChange: expressify(controller.rejectChange),
  getArtifact: expressify(controller.getArtifact),
  createWorkspace: expressify(controller.createWorkspace),
  getWorkspace: expressify(controller.getWorkspace),
  cleanupExpiredWorkspaces: expressify(controller.cleanupExpiredWorkspaces),
  cleanupSandbox: expressify(controller.cleanupSandbox),
}

function findPendingChange(session, changeId) {
  return session.pendingChanges?.find((change) => change.id === changeId)
}

function dirname(filePath) {
  const index = filePath.lastIndexOf('/')
  return index <= 0 ? '/' : filePath.slice(0, index)
}

function basename(filePath) {
  const index = filePath.lastIndexOf('/')
  return index === -1 ? filePath : filePath.slice(index + 1)
}

function toBuffer(value) {
  if (!value) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value.buffer && Buffer.isBuffer(value.buffer)) return value.buffer
  if (value.buffer instanceof ArrayBuffer) return Buffer.from(value.buffer)
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(value)
}

function serializeWorkspace(workspace) {
  return {
    id: workspace._id,
    sessionId: workspace.sessionId,
    projectId: workspace.projectId,
    provider: workspace.provider,
    status: workspace.status,
    createdAt: workspace.createdAt?.getTime?.() || null,
    updatedAt: workspace.updatedAt?.getTime?.() || null,
    lastUsedAt: workspace.lastUsedAt?.getTime?.() || null,
    expiresAt: workspace.expiresAt?.getTime?.() || null,
    drift: workspace.lastDrift || null,
  }
}
