import crypto from 'node:crypto'
import logger from '@overleaf/logger'
import { db } from '../mongodb.js'
import { getAgentRuntimeConfig } from '../RuntimeConfigManager.js'

export class SandboxSessionDisabledError extends Error {
  constructor() {
    super('Sandbox runtime is not enabled')
    this.name = 'SandboxSessionDisabledError'
    this.code = 'SANDBOX_NOT_ENABLED'
    this.statusCode = 409
  }
}

export class SandboxSessionInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SandboxSessionInputError'
    this.code = 'SANDBOX_INVALID_INPUT'
    this.statusCode = 400
  }
}

const PROJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const USER_ID_RE = /^[0-9a-fA-F]{24}$/
const REDACTED = '[redacted]'
const SECRET_RE =
  /(?:authorization\s*[:=]\s*bearer\s+\S+|["']?(?:api[_-]?key|apiKey|token|secret|password|credential)["']?\s*[=:]\s*["']?[^"'\s,}]+["']?|sk-[A-Za-z0-9_-]{8,})/gi
const TEXT_ARTIFACT_RE =
  /\.(?:aux|bbl|blg|csv|json|log|md|out|stderr|stdout|tex|text|txt|xml|yaml|yml)$/i
const DEFAULT_PROMPT = 'Review the project and report any useful findings.'

function generateSessionId() {
  return crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex')
}

function countDiffChanges(diff) {
  return ['created', 'modified', 'deleted', 'binaryChanged'].reduce(
    (count, key) => count + (Array.isArray(diff?.[key]) ? diff[key].length : 0),
    0
  )
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

async function createDefaultRuntime(config) {
  const { createRuntimeAdapter } = await import(
    '../runtime/RuntimeAdapterFactory.js'
  )
  return createRuntimeAdapter(config)
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

async function createDefaultDiffCollector() {
  const { ProjectDiffCollector } = await import('./ProjectDiffCollector.js')
  return new ProjectDiffCollector()
}

async function createDefaultPatchConverter() {
  const { PatchToPendingChanges } = await import('./PatchToPendingChanges.js')
  return new PatchToPendingChanges()
}

async function createDefaultProfileRegistry() {
  const { loadDefaultProfileRegistry } = await import(
    '../runtime/ProfileRegistry.js'
  )
  return loadDefaultProfileRegistry()
}

export class SandboxSessionManager {
  constructor(options = {}) {
    this.getRuntimeConfig = options.getRuntimeConfig || getAgentRuntimeConfig
    this.provider = options.provider
    this.runtime = options.runtime
    this.exporter = options.exporter
    this.diffCollector = options.diffCollector
    this.patchConverter = options.patchConverter
    this.profileRegistry = options.profileRegistry
    this.sessionsCollection = options.sessionsCollection || db.aiSandboxSessions
    this.artifactsCollection =
      options.artifactsCollection || db.aiSandboxArtifacts
    this.logger = options.logger || logger
    this.now = options.now || (() => new Date())
    this.generateSessionId = options.generateSessionId || generateSessionId
    this.activeSessions = options.activeSessions || new Map()
  }

  async *startSession(input = {}) {
    const config = this.getRuntimeConfig()
    if (!config.sandboxEnabled) {
      throw new SandboxSessionDisabledError()
    }

    const projectId = this.validateObjectId(input.projectId, 'projectId')
    const userId = this.validateObjectId(input.userId, 'userId')
    const prompt =
      typeof input.prompt === 'string' && input.prompt.trim()
        ? input.prompt.trim()
        : DEFAULT_PROMPT
    const sessionId = this.generateSessionId()
    const startedAt = this.now()

    let sandboxSession
    let manifest
    let provider

    await this.recordSession({
      _id: sessionId,
      projectId,
      userId,
      status: 'starting',
      createdAt: startedAt,
      updatedAt: startedAt,
    })

    try {
      provider = this.provider || (await createDefaultProvider(config))
      const exporter = this.exporter || (await createDefaultExporter())
      const runtime = this.runtime || (await createDefaultRuntime(config))
      const diffCollector =
        this.diffCollector || (await createDefaultDiffCollector())
      const patchConverter =
        this.patchConverter || (await createDefaultPatchConverter())
      const profileRegistry =
        this.profileRegistry || (await createDefaultProfileRegistry())
      const profileName = input.profile || config.agentRuntime.defaultProfile
      const runtimePrompt = profileRegistry.get(profileName)
        ? profileRegistry.buildPrompt(profileName, prompt)
        : prompt

      sandboxSession = await provider.createSession({
        id: sessionId,
        projectId,
        userId,
        config: config.sandbox,
      })
      this.activeSessions.set(sessionId, {
        provider,
        runtime,
        providerSessionId: sandboxSession.id,
        userId,
      })

      await this.markSession(sessionId, {
        status: 'running',
        providerSessionId: sandboxSession.id,
        workspacePath: sandboxSession.workspacePath,
        startedAt,
      })

      yield {
        type: 'session_started',
        sessionId,
        projectId,
        provider: config.sandbox.provider,
        runtimeAdapter: config.agentRuntime.adapter,
      }

      manifest = await exporter.exportProject(
        projectId,
        sandboxSession.workspacePath,
        {
          userId,
          sessionId,
        }
      )
      yield {
        type: 'project_exported',
        sessionId,
        fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
      }

      yield {
        type: 'runtime_started',
        sessionId,
        adapter: config.agentRuntime.adapter,
      }

      for await (const runtimeEvent of runtime.run({
        prompt: runtimePrompt,
        projectId,
        userId,
        sessionId,
        sandboxSession,
        credentials: input.credentials || {},
        profile: profileName,
      })) {
        yield {
          type: 'runtime_event',
          sessionId,
          event: runtimeEvent,
        }
      }

      const diff = await diffCollector.collect(
        sandboxSession.workspacePath,
        manifest
      )
      const pendingChanges = patchConverter
        .convert(diff, manifest, {
          projectId,
        })
        .map((change) => ({
          ...change,
          sandboxSessionId: sessionId,
        }))
      const profile = profileRegistry.get(profileName)
      const artifacts = profile?.artifactGlobs?.length
        ? await sandboxSession.collectArtifacts(profile.artifactGlobs)
        : []
      const artifactRefs = await this.storeArtifacts(sessionId, artifacts)
      yield {
        type: 'diff_collected',
        sessionId,
        changeCount: countDiffChanges(diff),
        diff,
        pendingChanges,
        artifacts: artifactRefs,
      }

      await this.markSession(sessionId, {
        pendingChanges,
        artifacts: artifactRefs,
      })

      await this.markSession(sessionId, {
        status: 'done',
        completedAt: this.now(),
      })

      yield {
        type: 'done',
        sessionId,
        status: 'done',
      }
    } catch (error) {
      await this.markSession(sessionId, {
        status: 'failed',
        failedAt: this.now(),
        errorCode: error.code || 'SANDBOX_SESSION_FAILED',
      })
      this.logger.warn(
        { err: error, sessionId, projectId },
        'sandbox session orchestration failed'
      )
      throw error
    } finally {
      this.activeSessions.delete(sessionId)
      if (provider?.destroySession && sandboxSession?.id) {
        await provider.destroySession(sandboxSession.id).catch((err) => {
          this.logger.warn(
            { err, sessionId },
            'failed to destroy sandbox session after run'
          )
        })
      }
    }
  }

  async stopSession(sessionId, userId) {
    if (!sessionId) {
      throw new SandboxSessionInputError('Missing sandboxSessionId')
    }

    const active = this.activeSessions.get(sessionId)
    if (!active) {
      await this.markSession(sessionId, {
        status: 'stopped',
        stoppedAt: this.now(),
        stopReason: 'not-active',
      })
      return { stopped: false, reason: 'not-active' }
    }

    if (userId && active.userId !== userId) {
      throw new SandboxSessionInputError('Sandbox session user mismatch')
    }

    await this.markSession(sessionId, {
      status: 'stopping',
      stopRequestedAt: this.now(),
    })

    await active.runtime?.stop?.(sessionId).catch((err) => {
      this.logger.warn({ err, sessionId }, 'failed to stop sandbox runtime')
    })
    await active.provider
      ?.destroySession?.(active.providerSessionId)
      .catch((err) => {
        this.logger.warn(
          { err, sessionId },
          'failed to destroy sandbox during stop'
        )
      })
    this.activeSessions.delete(sessionId)
    await this.markSession(sessionId, {
      status: 'stopped',
      stoppedAt: this.now(),
      stopReason: 'user-requested',
    })
    return { stopped: true }
  }

  validateObjectId(value, field) {
    const pattern = field === 'userId' ? USER_ID_RE : PROJECT_ID_RE
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new SandboxSessionInputError(`Invalid ${field}`)
    }
    return value
  }

  async recordSession(document) {
    if (!this.sessionsCollection?.insertOne) return
    await this.sessionsCollection.insertOne(document)
  }

  async markSession(sessionId, fields) {
    if (!this.sessionsCollection?.updateOne) return
    await this.sessionsCollection.updateOne(
      { _id: sessionId },
      { $set: { ...fields, updatedAt: this.now() } }
    )
  }

  async storeArtifacts(sessionId, artifacts) {
    if (!this.artifactsCollection?.insertMany || artifacts.length === 0) {
      return artifacts.map((artifact) => ({
        id: crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex'),
        path: artifact.path,
        size: artifact.size,
      }))
    }

    const expiresAt = new Date(
      Date.now() + (this.getRuntimeConfig().sandbox?.workspaceTtlMs || 86400000)
    )
    const docs = artifacts.map((artifact) => ({
      _id: crypto.randomUUID?.() || crypto.randomBytes(16).toString('hex'),
      sessionId,
      path: artifact.path,
      size: artifact.size,
      content: redactTextArtifact(artifact),
      createdAt: this.now(),
      expiresAt,
    }))
    await this.artifactsCollection.insertMany(docs)
    return docs.map((doc) => ({
      id: doc._id,
      path: doc.path,
      size: doc.size,
    }))
  }
}

export default SandboxSessionManager

export function redactTextArtifact(artifact) {
  const content = toBuffer(artifact.content)
  if (!isTextArtifact(artifact.path, content)) return artifact.content
  return Buffer.from(content.toString('utf8').replace(SECRET_RE, REDACTED))
}

function isTextArtifact(filePath = '', content = Buffer.alloc(0)) {
  if (TEXT_ARTIFACT_RE.test(filePath)) return true
  if (content.length === 0) return false
  const sample = content.subarray(0, Math.min(content.length, 1024))
  return !sample.includes(0)
}

function toBuffer(value) {
  if (!value) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return Buffer.from(String(value))
}
