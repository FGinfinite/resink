import crypto from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import net from 'node:net'
import os from 'node:os'
import settings from '@overleaf/settings'
import AgentController from './AgentController.js'
import SandboxAgentController from './SandboxAgentController.js'
import QuickEditController from './QuickEditController.js'
import AutocompleteController from './AutocompleteController.js'
import ModelConfigController from './ModelConfigController.js'
import PythonDependencyController from './PythonDependencyController.js'
import { getAgentRuntimeStatus } from './RuntimeConfigManager.js'
import { createRateLimiter } from './util/project-access.js'

/**
 * Middleware that requires x-user-id header (set by web proxy layer).
 * Acts as a defence-in-depth check: requests that bypass the web proxy
 * and hit ai-writing-agent directly on port 3060 will be rejected.
 */
function requireUserId(req, res, next) {
  const userId = req.headers['x-user-id']
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  const USER_ID_RE = /^[0-9a-fA-F]{24}$/
  if (!USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid user ID format' })
  }

  // Verify HMAC signature when proxy secret is configured
  const secret = settings.internal?.proxySecret
  if (secret) {
    const sig = req.headers['x-user-sig']
    if (!sig || typeof sig !== 'string') {
      return res.status(401).json({ error: 'Missing user signature' })
    }
    const HEX_RE = /^[0-9a-f]{64}$/
    if (!HEX_RE.test(sig)) {
      return res.status(401).json({ error: 'Invalid user signature format' })
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(userId)
      .digest('hex')
    const sigBuf = Buffer.from(sig, 'hex')
    const expectedBuf = Buffer.from(expected, 'hex')
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return res.status(401).json({ error: 'Invalid user signature' })
    }
  }

  next()
}

/**
 * Check whether an IP address is a loopback address.
 * Covers the full 127.0.0.0/8 range and IPv4-mapped IPv6 variants (::ffff:127.x.x.x).
 */
function isLoopbackAddress(addr) {
  if (!addr) return false
  // Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x -> x.x.x.x)
  const normalized = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  if (normalized === '::1') return true
  if (net.isIPv4(normalized)) {
    return normalized.startsWith('127.')
  }
  return false
}

/**
 * Middleware that validates x-ai-proxy-secret header when configured.
 * Ensures requests actually come from the web proxy layer, not direct access.
 */
function requireProxySecret(req, res, next) {
  const secret = settings.internal?.proxySecret
  if (!secret) {
    // Only allow bypass in non-production if explicitly configured AND request is from loopback
    const allowBypass =
      settings.internal?.allowProxySecretBypass === true &&
      process.env.NODE_ENV !== 'production'
    if (allowBypass && isLoopbackAddress(req.socket?.remoteAddress)) {
      return next()
    }
    return res
      .status(500)
      .json({ error: 'AI proxy secret not configured (set AI_PROXY_SECRET)' })
  }
  if (req.headers['x-ai-proxy-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid proxy authentication' })
  }
  next()
}

// --- Per-user rate limiters ---
const _messageRateCheck = createRateLimiter({
  windowMs: settings.aiAssistant?.messageRateWindowMs || 60_000,
  max: settings.aiAssistant?.messageRateMax || 60,
})
const _uploadRateCheck = createRateLimiter({
  windowMs: settings.aiAssistant?.uploadRateWindowMs || 60_000,
  max: settings.aiAssistant?.uploadRateMax || 20,
})

/**
 * Build Express middleware from a rate-limit checker function.
 * The checker is produced by createRateLimiter and takes a userId string.
 */
function rateLimitMiddleware(checker) {
  return function rateLimit(req, res, next) {
    const userId = req.headers['x-user-id']
    if (!userId) return next()
    if (!checker(userId)) {
      return res.status(429).json({ error: 'Too many requests' })
    }
    next()
  }
}

const messageRateLimit = rateLimitMiddleware(_messageRateCheck)
const uploadRateLimit = rateLimitMiddleware(_uploadRateCheck)

function requireAdmin(req, res, next) {
  if (req.headers['x-user-is-admin'] !== 'true') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

export function createRouter() {
  const router = Router()

  // Configure multer for attachment uploads
  const imageConfig = settings.image || {}
  const allowedMimes = imageConfig.allowedMimes || [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
  ]
  const attachmentUpload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: imageConfig.maxSize || 5 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true)
      } else {
        cb(new Error(`Unsupported file type: ${file.mimetype}`))
      }
    },
  })

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  // Apply proxy secret validation to all routes except health check
  router.use((req, res, next) => {
    if (req.path === '/health') return next()
    requireProxySecret(req, res, next)
  })

  // File search for @ mention autocomplete
  router.get(
    '/projects/:projectId/files',
    requireUserId,
    AgentController.searchFiles
  )

  // Runtime status for feature-flagged sandbox migration.
  router.get('/runtime/status', requireUserId, (_req, res) => {
    res.json(getAgentRuntimeStatus())
  })

  // Sandbox session orchestration for the feature-flagged runtime migration.
  router.post(
    '/sandbox/sessions',
    requireUserId,
    requireAdmin,
    messageRateLimit,
    SandboxAgentController.startSession
  )
  router.post(
    '/sandbox/workspaces',
    requireUserId,
    requireAdmin,
    messageRateLimit,
    SandboxAgentController.createWorkspace
  )
  router.get(
    '/sandbox/workspaces/:workspaceId',
    requireUserId,
    requireAdmin,
    SandboxAgentController.getWorkspace
  )
  router.post(
    '/sandbox/sessions/:sandboxSessionId/stop',
    requireUserId,
    requireAdmin,
    SandboxAgentController.stopSession
  )
  router.post(
    '/sandbox/sessions/:sandboxSessionId/changes/:changeId/accept',
    requireUserId,
    requireAdmin,
    SandboxAgentController.acceptChange
  )
  router.post(
    '/sandbox/sessions/:sandboxSessionId/changes/:changeId/reject',
    requireUserId,
    requireAdmin,
    SandboxAgentController.rejectChange
  )
  router.get(
    '/sandbox/sessions/:sandboxSessionId/artifacts/:artifactId',
    requireUserId,
    requireAdmin,
    SandboxAgentController.getArtifact
  )

  // Agent Context Project Instructions (AGENTS.md-backed)
  router.get(
    '/projects/:projectId/agent-instructions',
    requireUserId,
    AgentController.getAgentInstructions
  )
  router.post(
    '/projects/:projectId/agent-instructions/create',
    requireUserId,
    AgentController.createAgentInstructions
  )
  router.put(
    '/projects/:projectId/agent-instructions/draft',
    requireUserId,
    AgentController.saveAgentInstructionsDraft
  )

  // Agent Context Memories
  router.get('/memories', requireUserId, AgentController.listMemories)
  router.post('/memories', requireUserId, AgentController.createMemory)
  router.patch(
    '/memories/:memoryId',
    requireUserId,
    AgentController.updateMemory
  )
  router.put(
    '/memories/:memoryId',
    requireUserId,
    AgentController.updateMemory
  )
  router.delete(
    '/memories/:memoryId',
    requireUserId,
    AgentController.deleteMemory
  )
  router.get(
    '/memory-suggestions',
    requireUserId,
    AgentController.listMemorySuggestions
  )
  router.post(
    '/memory-suggestions/:suggestionId/accept',
    requireUserId,
    AgentController.acceptMemorySuggestion
  )
  router.post(
    '/memory-suggestions/:suggestionId/dismiss',
    requireUserId,
    AgentController.dismissMemorySuggestion
  )

  // Completion rules
  router.get(
    '/projects/:projectId/completion-rules',
    requireUserId,
    AgentController.getCompletionRules
  )
  router.put(
    '/projects/:projectId/completion-rules',
    requireUserId,
    AgentController.updateCompletionRules
  )

  // Session management
  router.get('/sessions', requireUserId, AgentController.listSessions)
  router.post('/sessions', requireUserId, AgentController.createSession)
  router.get('/sessions/:sessionId', requireUserId, AgentController.getSession)
  router.get(
    '/sessions/:sessionId/context-snapshot/:turnId',
    requireUserId,
    AgentController.getContextSnapshot
  )
  router.get(
    '/sessions/:sessionId/session-summary',
    requireUserId,
    AgentController.getSessionSummary
  )
  router.put(
    '/sessions/:sessionId',
    requireUserId,
    AgentController.updateSession
  )
  router.delete(
    '/sessions/:sessionId',
    requireUserId,
    AgentController.deleteSession
  )
  router.get(
    '/sessions/:sessionId/team-runs',
    requireUserId,
    AgentController.listTeamRuns
  )
  router.get(
    '/sessions/:sessionId/team-runs/:teamId',
    requireUserId,
    AgentController.getTeamRun
  )
  router.post(
    '/sessions/:sessionId/team-runs/:teamId/cancel',
    requireUserId,
    AgentController.cancelTeamRun
  )
  router.post(
    '/sessions/:sessionId/team-runs/:teamId/tasks/:taskId/retry',
    requireUserId,
    AgentController.retryTeamRunTask
  )

  // Messaging
  router.post(
    '/sessions/:sessionId/messages',
    requireUserId,
    messageRateLimit,
    AgentController.sendMessage
  )

  // Independent file upload (no session required)
  router.post(
    '/files',
    requireUserId,
    uploadRateLimit,
    (req, res, next) => {
      attachmentUpload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message })
        next()
      })
    },
    AgentController.uploadFile
  )

  // File download by ID (no session required)
  router.get('/files/:fileId', requireUserId, AgentController.getFile)

  // Attachments (image upload)
  router.post(
    '/sessions/:sessionId/attachments',
    requireUserId,
    uploadRateLimit,
    (req, res, next) => {
      attachmentUpload.single('file')(req, res, (err) => {
        if (err) {
          // Return 400 for multer validation errors (file type, size)
          return res.status(400).json({ error: err.message })
        }
        next()
      })
    },
    AgentController.uploadAttachment
  )
  router.get(
    '/sessions/:sessionId/attachments/:attachmentId',
    requireUserId,
    AgentController.getAttachment
  )
  router.get(
    '/sessions/:sessionId/artifacts/:artifactId',
    requireUserId,
    AgentController.getSessionArtifact
  )

  // Stop active agent loop
  router.post(
    '/sessions/:sessionId/stop',
    requireUserId,
    AgentController.stopSession
  )

  // Manual context compaction
  router.post(
    '/sessions/:sessionId/compact',
    requireUserId,
    AgentController.compactSession
  )

  // Change confirmation (synchronous edit flow)
  router.post(
    '/sessions/:sessionId/confirm-change/:changeId',
    requireUserId,
    AgentController.confirmChange
  )

  // Change management (deprecated — kept for backward compatibility)
  router.post(
    '/sessions/:sessionId/changes/:changeId/accept',
    requireUserId,
    AgentController.acceptChange
  )
  router.post(
    '/sessions/:sessionId/changes/:changeId/reject',
    requireUserId,
    AgentController.rejectChange
  )
  router.post(
    '/sessions/:sessionId/changes/accept-all',
    requireUserId,
    AgentController.acceptAllChanges
  )
  router.post(
    '/sessions/:sessionId/changes/reject-all',
    requireUserId,
    AgentController.rejectAllChanges
  )

  // Quick edit (no session required)
  router.post('/quick-edit', requireUserId, QuickEditController.quickEdit)

  // Autocomplete (no session required, auth enforced at middleware + controller level)
  router.post('/autocomplete', requireUserId, AutocompleteController.complete)
  router.post(
    '/autocomplete/stream',
    requireUserId,
    AutocompleteController.streamComplete
  )

  // Model slots (user - read only)
  router.get('/model-slots', requireUserId, ModelConfigController.listSlots)
  router.get(
    '/model-slots/default',
    requireUserId,
    ModelConfigController.getDefaultSlot
  )

  // Admin - model configs
  router.get(
    '/admin/model-configs',
    requireUserId,
    requireAdmin,
    ModelConfigController.listConfigs
  )
  router.post(
    '/admin/model-configs',
    requireUserId,
    requireAdmin,
    ModelConfigController.createConfig
  )
  router.put(
    '/admin/model-configs/:id',
    requireUserId,
    requireAdmin,
    ModelConfigController.updateConfig
  )
  router.delete(
    '/admin/model-configs/:id',
    requireUserId,
    requireAdmin,
    ModelConfigController.deleteConfig
  )
  router.post(
    '/admin/sandbox/cleanup',
    requireUserId,
    requireAdmin,
    SandboxAgentController.cleanupSandbox
  )
  router.get(
    '/admin/python/dependency-requests',
    requireUserId,
    requireAdmin,
    PythonDependencyController.listRequests
  )
  router.get(
    '/admin/python/dependency-requests/:requestId',
    requireUserId,
    requireAdmin,
    PythonDependencyController.getRequest
  )
  router.post(
    '/admin/python/dependency-requests/:requestId/approve',
    requireUserId,
    requireAdmin,
    PythonDependencyController.approveRequest
  )
  router.post(
    '/admin/python/dependency-requests/:requestId/deny',
    requireUserId,
    requireAdmin,
    PythonDependencyController.denyRequest
  )
  router.post(
    '/projects/:projectId/python/dependency-requests/:requestId/approve',
    requireUserId,
    PythonDependencyController.approveProjectRequest
  )
  router.post(
    '/projects/:projectId/python/dependency-requests/:requestId/deny',
    requireUserId,
    PythonDependencyController.denyProjectRequest
  )

  // Admin - model slots
  router.get(
    '/admin/model-slots',
    requireUserId,
    requireAdmin,
    ModelConfigController.listAdminSlots
  )
  router.post(
    '/admin/model-slots',
    requireUserId,
    requireAdmin,
    ModelConfigController.createSlot
  )
  router.put(
    '/admin/model-slots/:slug',
    requireUserId,
    requireAdmin,
    ModelConfigController.updateSlot
  )
  router.delete(
    '/admin/model-slots/:slug',
    requireUserId,
    requireAdmin,
    ModelConfigController.deleteSlot
  )

  // Admin - system config
  router.get(
    '/admin/system-config',
    requireUserId,
    requireAdmin,
    ModelConfigController.getSystemConfig
  )
  router.put(
    '/admin/system-config',
    requireUserId,
    requireAdmin,
    ModelConfigController.updateSystemConfig
  )

  return router
}

export default createRouter
