import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import settings from '@overleaf/settings'
import path from 'node:path'
import fs from 'node:fs'

import { ObjectId, db, allocateSeq, mongoClient } from './mongodb.js'
import { createAgentLoopForSession } from './agent/AgentLoopFactory.js'
import { ConfirmationChannel } from './agent/ConfirmationChannel.js'
import { ContextManager } from './agent/ContextManager.js'
import { AgentMessageStore } from './agent/AgentMessageStore.js'
import {
  AgentChangeSetService,
  serializeChangeSet,
} from './agent/AgentChangeSetService.js'
import { LiveDraftChangeBridge } from './agent/LiveDraftChangeBridge.js'
import { CanonicalWritebackService } from './agent/CanonicalWritebackService.js'
import { PersistentWorkspaceManager } from './sandbox/PersistentWorkspaceManager.js'
import { ToolRegistry } from './tool/ToolRegistry.js'
import { ToolsetPolicy } from './tool/ToolsetPolicy.js'
import { ReadDocumentTool } from './tool/read.js'
import { EditDocumentTool } from './tool/edit.js'
import { DeleteFileTool } from './tool/delete.js'
import { ListFilesTool } from './tool/list.js'
import { SearchProjectTool } from './tool/search.js'
import { BibLookupTool } from './tool/bib_lookup.js'
import { BibManageTool } from './tool/bib_manage.js'
import { DocStructureMapTool } from './tool/doc_structure_map.js'
import { LabelRefAuditTool } from './tool/label_ref_audit.js'
import { ViewFileTool } from './tool/view-file.js'
import { CompileLatexTool } from './tool/compile_latex.js'
import { SyncWorkspaceChangesTool } from './tool/sync_workspace_changes.js'
import { RunCommandTool } from './tool/run_command.js'
import { WriteWorkspaceFileTool } from './tool/write_workspace_file.js'
import { ActivateSkillTool } from './tool/activate_skill.js'
import { ReadSkillReferenceTool } from './tool/read_skill_reference.js'
import { RunSkillScriptTool } from './tool/run_skill_script.js'
import { StartAgentTaskTool } from './tool/start_agent_task.js'
import { StartAgentTeamTool } from './tool/start_agent_team.js'
import { HandoffToAgentTool, ReturnFromHandoffTool } from './tool/handoff_tools.js'
import { ProposeMemoryTool } from './tool/propose_memory.js'
import {
  AgentTeamRunService,
  normalizeObjectIdString,
} from './agent-team/AgentTeamRunService.js'
import { AgentTeamOrchestrator } from './agent-team/AgentTeamOrchestrator.js'
import { SkillRegistry } from './skill/SkillRegistry.js'
import {
  SessionNotFoundError,
  SessionExpiredError,
  ChangeNotFoundError,
  ValidationError,
  ForbiddenError,
} from './Errors.js'
import {
  DocumentAdapter,
  EditMatchError,
  RebaseConflictError as DocRebaseConflictError,
  VersionConflictError,
} from './adapter/DocumentAdapter.js'
import { ProjectAdapter } from './adapter/ProjectAdapter.js'
import { FileStoreAdapter } from './adapter/FileStoreAdapter.js'
import { ProjectInstructionService } from './agent-context/ProjectInstructionService.js'
import { MemoryService } from './agent-context/MemoryService.js'
import { MemorySuggestionService } from './agent-context/MemorySuggestionService.js'
import { ContextSnapshotService } from './agent-context/ContextSnapshotService.js'
import { SessionSummaryService } from './agent-context/SessionSummaryService.js'
import { RunBudget } from './agent/RunBudget.js'
import { getModelConfigService } from './ModelConfigService.js'
import { getAgentRuntimeConfig } from './RuntimeConfigManager.js'
import { AGENT_LOOP_V2_RUNTIME } from './agent/AgentLoopV2.js'
const documentAdapter = new DocumentAdapter()
const projectAdapter = new ProjectAdapter()
const fileStoreAdapter = new FileStoreAdapter()
const contextManager = new ContextManager()
const agentMessageStore = new AgentMessageStore({ db, allocateSeq })
const agentChangeSetService = new AgentChangeSetService({ db })
const canonicalWritebackService = new CanonicalWritebackService({
  documentAdapter,
  changeSetService: agentChangeSetService,
})
const liveDraftChangeBridge = new LiveDraftChangeBridge({
  changeSetService: agentChangeSetService,
  canonicalWritebackService,
})
const persistentWorkspaceManager = new PersistentWorkspaceManager()
const toolsetPolicy = new ToolsetPolicy()
let agentTeamOrchestrator = null
const agentTeamRunService = new AgentTeamRunService({
  db,
  stopSessionIds: stopActiveSessionsById,
  retryTaskRunner: retryAgentTeamTask,
})

function buildAgentLoopAdapters(llmAdapter) {
  return {
    document: documentAdapter,
    project: projectAdapter,
    llm: llmAdapter,
    fileStore: fileStoreAdapter,
    workspaceManager: persistentWorkspaceManager,
    agentMessageStore,
    liveDraftChangeBridge,
  }
}

const PROJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const USER_ID_RE = /^[0-9a-fA-F]{24}$/
const DOC_ID_RE = /^[0-9a-fA-F]{24}$/

const MAX_SESSION_TITLE_LENGTH = settings.aiAssistant?.maxSessionTitleLength || 200
const CHANGE_HISTORY_MAX_ITEMS = settings.aiAssistant?.maxChangeHistoryItems || 200
const SESSION_TTL_MS =
  settings.aiAssistant?.sessionTtlMs || 30 * 24 * 60 * 60 * 1000
const SSE_HEARTBEAT_MS = settings.aiAssistant?.sseHeartbeatMs || 15_000
// eslint-disable-next-line no-control-regex
const SESSION_TITLE_CONTROL_RE = /[\x00-\x1f\x7f]/g

function getEnabledAgentContextConfig() {
  const agentContext = getAgentRuntimeConfig().agentContext || {}
  if (!agentContext.enabled) {
    throw new ForbiddenError('Agent Context is disabled')
  }
  return agentContext
}

function createProjectInstructionService(agentContext) {
  return new ProjectInstructionService({
    projectAdapter,
    documentAdapter,
    changeSetService: agentChangeSetService,
    canonicalWritebackService,
    projectInstructionsFile: agentContext.projectInstructionsFile,
    maxInstructionChars: agentContext.maxInstructionChars,
  })
}

function createMemoryService(agentContext) {
  return new MemoryService({
    maxMemoryChars: agentContext.maxMemoryChars,
  })
}

function createMemorySuggestionService(agentContext) {
  return new MemorySuggestionService({
    memoryService: createMemoryService(agentContext),
    ttlMs: agentContext.suggestionTtlMs,
  })
}

function sanitizeSessionTitle(rawTitle) {
  if (rawTitle == null) return null
  const cleaned = String(rawTitle)
    .replace(SESSION_TITLE_CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned.slice(0, MAX_SESSION_TITLE_LENGTH)
}

function isDraftBackedChange(change) {
  return (
    change?.changeSetId &&
    ObjectId.isValid(change.changeSetId) &&
    change?.id &&
    ObjectId.isValid(change.id)
  )
}

async function syncDraftBackedChangeStatus(change, session, status, fields = {}) {
  if (!isDraftBackedChange(change)) return null
  return agentChangeSetService.updateDraftStatus({
    changeId: change.id,
    sessionId: session._id,
    projectId: session.projectId,
    userId: session.userId,
    status,
    ...fields,
  })
}

function resolveDefaultSessionRuntimeMode(requestedRuntimeMode) {
  if (typeof requestedRuntimeMode === 'string' && requestedRuntimeMode.trim()) {
    const normalized = requestedRuntimeMode.trim()
    return normalized === 'sandbox-v0'
      ? normalized
      : AGENT_LOOP_V2_RUNTIME
  }
  return getAgentRuntimeConfig().runtimeMode
}

function serializeRuntimeMode(runtimeMode) {
  return runtimeMode === 'sandbox-v0'
    ? runtimeMode
    : AGENT_LOOP_V2_RUNTIME
}

function serializeSession(session, messages = [], changeSets = []) {
  return {
    id: session._id.toString(),
    projectId: session.projectId,
    userId: session.userId || null,
    profile: session.profile || session.agentName || 'default',
    runtimeMode: serializeRuntimeMode(session.runtimeMode),
    model: session.model || null,
    status: session.status || 'active',
    parentSessionId:
      session.parentSessionId?.toString?.() ||
      session.parentId?.toString?.() ||
      null,
    rootSessionId:
      session.rootSessionId?.toString?.() || session._id.toString(),
    workspaceId: session.workspaceId || null,
    workspaceStatus: session.workspaceStatus || null,
    workspaceUpdatedAt: session.workspaceUpdatedAt?.getTime?.() || null,
    workspaceDrift: session.workspaceDrift || session.lastDrift || null,
    pendingChanges: Array.isArray(session.pendingChanges)
      ? session.pendingChanges
      : [],
    changeSets,
    artifacts: Array.isArray(session.artifacts) ? session.artifacts : [],
    activeHandoff: session.activeHandoff || null,
    activeTurn: session.activeTurn || null,
    title: session.title || 'Untitled session',
    messages,
    changeHistory: session.changeHistory || [],
    hasMore: session.hasMore,
    nextBeforeSeq: session.nextBeforeSeq,
    createdAt: session.createdAt?.getTime?.() || Date.now(),
    updatedAt: session.updatedAt?.getTime?.() || Date.now(),
    lastTurnAt:
      session.lastTurnAt?.getTime?.() ||
      session.updatedAt?.getTime?.() ||
      null,
    expiresAt: session.expiresAt?.getTime?.() || null,
    archivedAt: session.archivedAt?.getTime?.() || null,
  }
}

function serializeSessionSummary(session) {
  return {
    id: session._id.toString(),
    projectId: session.projectId,
    title: session.title || 'Untitled session',
    profile: session.profile || session.agentName || 'default',
    runtimeMode: serializeRuntimeMode(session.runtimeMode),
    model: session.model || null,
    status: session.status || 'active',
    parentSessionId:
      session.parentSessionId?.toString?.() ||
      session.parentId?.toString?.() ||
      null,
    workspaceId: session.workspaceId || null,
    createdAt: session.createdAt?.getTime?.() || Date.now(),
    updatedAt: session.updatedAt?.getTime?.() || Date.now(),
    lastTurnAt:
      session.lastTurnAt?.getTime?.() ||
      session.updatedAt?.getTime?.() ||
      null,
    expiresAt: session.expiresAt?.getTime?.() || null,
  }
}

function serializeDate(value) {
  return value?.toISOString?.() || null
}

function serializeMemory(memory) {
  return {
    id: memory._id?.toString?.() || memory._id,
    content: memory.content,
    scope: memory.scope,
    projectId: memory.projectId || null,
    status: memory.status,
    source: memory.source,
    tags: memory.tags || [],
    createdAt: serializeDate(memory.createdAt),
    updatedAt: serializeDate(memory.updatedAt),
    disabledAt: serializeDate(memory.disabledAt),
    deletedAt: serializeDate(memory.deletedAt),
    lastUsedAt: serializeDate(memory.lastUsedAt),
    useCount: memory.useCount || 0,
  }
}

function serializeMemorySuggestion(suggestion) {
  return {
    id: suggestion._id?.toString?.() || suggestion._id,
    proposedContent: suggestion.proposedContent,
    scope: suggestion.scope,
    projectId: suggestion.projectId || null,
    sessionId: suggestion.sessionId,
    messageId: suggestion.messageId || null,
    reason: suggestion.reason,
    status: suggestion.status,
    memoryId: suggestion.memoryId?.toString?.() || suggestion.memoryId || null,
    createdAt: serializeDate(suggestion.createdAt),
    updatedAt: serializeDate(suggestion.updatedAt),
    acceptedAt: serializeDate(suggestion.acceptedAt),
    dismissedAt: serializeDate(suggestion.dismissedAt),
    expiresAt: serializeDate(suggestion.expiresAt),
  }
}

function serializeContextSnapshot(snapshot) {
  if (!snapshot) return null
  return {
    id: snapshot._id?.toString?.() || snapshot._id,
    sessionId: snapshot.sessionId,
    projectId: snapshot.projectId,
    userId: snapshot.userId,
    turnId: snapshot.turnId,
    messageId: snapshot.messageId || null,
    sourceRefs: snapshot.sourceRefs || [],
    totals: snapshot.totals || {
      sourceCount: 0,
      tokenEstimate: 0,
      memoryCount: 0,
      recalledCount: 0,
    },
    createdAt: serializeDate(snapshot.createdAt),
  }
}

function serializeSessionSummaryRecord(summary) {
  if (!summary) return null
  return {
    id: summary._id?.toString?.() || summary._id,
    sessionId: summary.sessionId,
    projectId: summary.projectId,
    userId: summary.userId,
    summary: summary.summary,
    sourceMessageRange: summary.sourceMessageRange || { fromSeq: 0, toSeq: 0 },
    tokenEstimate: summary.tokenEstimate || 0,
    status: summary.status,
    createdAt: serializeDate(summary.createdAt),
    updatedAt: serializeDate(summary.updatedAt),
    supersededAt: serializeDate(summary.supersededAt),
  }
}

function parseObjectId(value, field) {
  if (!ObjectId.isValid(value)) {
    throw new ValidationError(`Invalid ${field} format`)
  }
  return new ObjectId(value)
}

function serializeMessages(messages) {
  return messages.map((msg, index) => ({
    id: msg._id?.toString() || `msg-${msg.seq || index}`,
    role: msg.role,
    content: msg.content,
    contentBlocks: msg.contentBlocks?.filter(block => block.type !== 'thinking'),
    status: msg.status,
    error: msg.error,
    isCompaction: msg.isSummary || undefined,
    timestamp: msg.timestamp?.getTime?.() || Date.now(),
    // Expose attachment metadata (strip storageKey for security)
    ...(msg.attachments?.length > 0 && {
      attachments: msg.attachments.map(a => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
    }),
  }))
}

function serializeToolCalls(toolCalls) {
  return toolCalls.map(toolCall => ({
    id: toolCall.toolCallId,
    messageId: toolCall.messageId || null,
    tool: toolCall.name || 'unknown',
    arguments: toolCall.arguments || {},
    status: toolCall.status || 'unknown',
    resultSummary: toolCall.resultSummary || null,
    durationMs: toolCall.durationMs || null,
    error: toolCall.error || null,
    relatedChangeIds: toolCall.relatedChangeIds || [],
    relatedArtifactIds: toolCall.relatedArtifactIds || [],
    createdAt: toolCall.createdAt?.getTime?.() || null,
    startedAt: toolCall.startedAt?.getTime?.() || null,
    finishedAt: toolCall.finishedAt?.getTime?.() || null,
  }))
}

function isTerminalSessionStatus(status) {
  return status === 'archived' || status === 'ended'
}

async function ensurePersistentWorkspaceForSession(session, userId) {
  if (!userId) return null
  try {
    const result = await persistentWorkspaceManager.ensureWorkspace({
      sessionId: session._id.toString(),
      projectId: session.projectId,
      userId,
    })
    return {
      workspace: result.workspace,
      workspaceId: result.workspace._id,
      workspacePath: result.sandboxSession?.workspacePath || null,
      sandboxSession: result.sandboxSession || null,
      created: result.created,
      drift: result.drift,
    }
  } catch (error) {
    logger.warn(
      {
        err: error,
        sessionId: session._id.toString(),
        projectId: session.projectId,
      },
      'persistent workspace ensure failed; continuing without workspace'
    )
    return null
  }
}

// Short-lived cache for project access checks (userId:projectId → { result, expiry })
const _projectAccessCache = new Map()
const PROJECT_ACCESS_CACHE_TTL = settings.projectAccess?.controllerCacheTtlMs || 60_000 // 1 minute

/**
 * Verify the user has access to the project via Web internal API.
 * @param {string} projectId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function _checkProjectAccess(projectId, userId) {
  // Validate format to prevent path traversal / SSRF
  if (!PROJECT_ID_RE.test(projectId) || !USER_ID_RE.test(userId)) {
    return false
  }

  const cacheKey = `${userId}:${projectId}`
  const cached = _projectAccessCache.get(cacheKey)
  if (cached && Date.now() < cached.expiry) {
    return cached.result
  }

  try {
    const webConfig = settings.apis?.web || {}
    const webUrl = webConfig.url || 'http://127.0.0.1:3000'
    const authUser = webConfig.user || 'overleaf'
    const authPass = webConfig.pass || ''

    const url = `${webUrl}/internal/project/${projectId}/membership/${userId}`
    const headers = {}
    if (authPass) {
      headers.Authorization = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(settings.projectAccess?.requestTimeoutMs || 5000),
    })

    const result = response.ok
    try { await response.body?.cancel() } catch {}
    _projectAccessCache.set(cacheKey, { result, expiry: Date.now() + PROJECT_ACCESS_CACHE_TTL })

    // Periodic cleanup when cache grows large
    if (_projectAccessCache.size > (settings.projectAccess?.cacheCleanupThreshold || 5000)) {
      const now = Date.now()
      for (const [key, entry] of _projectAccessCache) {
        if (now >= entry.expiry) _projectAccessCache.delete(key)
      }
    }

    if (_projectAccessCache.size > (settings.projectAccess?.cacheForceCleanupThreshold || 20000)) {
      const oldestKey = _projectAccessCache.keys().next().value
      _projectAccessCache.delete(oldestKey)
    }

    return result
  } catch {
    // Don't cache network errors — let next request retry
    return false
  }
}

/**
 * Verify the user has write access to the project via Web internal API.
 * Uses a separate write-membership endpoint that checks canUserWriteProjectContent.
 * @param {string} projectId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function _checkProjectWriteAccess(projectId, userId) {
  // Validate format to prevent path traversal / SSRF
  if (!PROJECT_ID_RE.test(projectId) || !USER_ID_RE.test(userId)) {
    return false
  }

  const cacheKey = `write:${userId}:${projectId}`
  const cached = _projectAccessCache.get(cacheKey)
  if (cached && Date.now() < cached.expiry) {
    return cached.result
  }

  try {
    const webConfig = settings.apis?.web || {}
    const webUrl = webConfig.url || 'http://127.0.0.1:3000'
    const authUser = webConfig.user || 'overleaf'
    const authPass = webConfig.pass || ''

    const url = `${webUrl}/internal/project/${projectId}/write-membership/${userId}`
    const headers = {}
    if (authPass) {
      headers.Authorization = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(settings.projectAccess?.requestTimeoutMs || 5000),
    })

    const result = response.ok
    try { await response.body?.cancel() } catch {}
    _projectAccessCache.set(cacheKey, { result, expiry: Date.now() + PROJECT_ACCESS_CACHE_TTL })

    // Periodic cleanup when cache grows large (shared with _checkProjectAccess)
    if (_projectAccessCache.size > (settings.projectAccess?.cacheCleanupThreshold || 5000)) {
      const now = Date.now()
      for (const [key, entry] of _projectAccessCache) {
        if (now >= entry.expiry) _projectAccessCache.delete(key)
      }
    }

    if (_projectAccessCache.size > (settings.projectAccess?.cacheForceCleanupThreshold || 20000)) {
      const oldestKey = _projectAccessCache.keys().next().value
      _projectAccessCache.delete(oldestKey)
    }

    return result
  } catch {
    // Don't cache network errors — let next request retry
    return false
  }
}

// Active confirmation channels: sessionId → ConfirmationChannel
const activeChannels = new Map()

// Active agent loops: sessionId → AgentLoop
const activeAgentLoops = new Map()

// Per-user active root session tracking
const activeRootSessionsByUser = new Map()  // userId → Set<sessionId>
const MAX_USER_CONCURRENT_SESSIONS = settings.aiAssistant?.maxConcurrentSessions || 3

// Maximum number of items to keep in _streamingContext (most recent N)
const STREAMING_CONTEXT_MAX_ITEMS = settings.aiAssistant?.streamingContextMaxItems || 200

// Maximum number of items to keep in toolContextMessages (most recent N)
const TOOL_CONTEXT_MAX_ITEMS = settings.memory?.maxToolContextItems || 200

// Maximum total characters for accumulated message content (fullContent + contentBlocks)
const MAX_MESSAGE_CHARS = settings.aiAssistant?.maxMessageChars || 2_000_000

/**
 * Append messages to a toolContext store, evicting oldest entries if the limit
 * is exceeded.  Mutates `store` in place.
 * @param {Array} store - The toolContextMessages array
 * @param {Array|Object} messages - Message(s) to push
 */
function pushToolContext(store, messages) {
  const items = Array.isArray(messages) ? messages : [messages]
  store.push(...items)
  if (store.length > TOOL_CONTEXT_MAX_ITEMS) {
    store.splice(0, store.length - TOOL_CONTEXT_MAX_ITEMS)
  }
}

async function shutdown({ reason } = {}) {
  logger.info(
    { reason, activeLoops: activeAgentLoops.size, activeChannels: activeChannels.size },
    'Shutting down active AI sessions'
  )
  for (const [sid, loop] of activeAgentLoops) {
    try { loop.stop() } catch (err) {
      logger.warn({ sessionId: sid, err }, 'Failed to stop agent loop during shutdown')
    }
  }
  for (const [sid, channel] of activeChannels) {
    try { channel.abort() } catch (err) {
      logger.warn({ sessionId: sid, err }, 'Failed to abort confirmation channel during shutdown')
    }
  }
  await db.aiSessions.updateMany(
    {
      _id: { $in: Array.from(activeAgentLoops.keys()).map(sid => new ObjectId(sid)) },
      'activeTurn.status': 'running',
    },
    {
      $set: {
        'activeTurn.status': 'interrupted',
        'activeTurn.reason': reason || 'shutdown',
        'activeTurn.interruptedAt': new Date(),
        _streamingInterrupted: true,
        updatedAt: new Date(),
      },
    }
  ).catch(err => logger.warn({ err }, 'Failed to persist interrupted active turns during shutdown'))
  activeRootSessionsByUser.clear()
}

// TTL for unreferenced files (not yet attached to a session)
const UNREFERENCED_TTL_MS = settings.aiAssistant?.attachmentUnreferencedTtlMs || 24 * 60 * 60 * 1000 // 1 day

// TTL for referenced files (attached to a session via message)
const REFERENCED_TTL_MS = settings.aiAssistant?.attachmentReferencedTtlMs || 3 * 24 * 60 * 60 * 1000 // 3 days

/**
 * Safely unlink a file without blocking the event loop.
 * @param {string|undefined|null} filePath
 */
async function safeUnlink(filePath) {
  if (!filePath) return
  try { await fs.promises.unlink(filePath) } catch {}
}

// Initialize tool registry
const toolRegistry = new ToolRegistry()
toolRegistry.register(new ReadDocumentTool())
toolRegistry.register(new EditDocumentTool())
toolRegistry.register(new DeleteFileTool())
toolRegistry.register(new ListFilesTool())
toolRegistry.register(new SearchProjectTool())
toolRegistry.register(new BibLookupTool())
toolRegistry.register(new BibManageTool())
toolRegistry.register(new DocStructureMapTool())
toolRegistry.register(new LabelRefAuditTool())
toolRegistry.register(new ViewFileTool())
toolRegistry.register(new CompileLatexTool())
toolRegistry.register(new RunCommandTool())
toolRegistry.register(new WriteWorkspaceFileTool())
toolRegistry.register(new SyncWorkspaceChangesTool({
  workspaceManager: persistentWorkspaceManager,
}))
toolRegistry.register(new ProposeMemoryTool({
  suggestionService: createMemorySuggestionService(
    getAgentRuntimeConfig().agentContext || {}
  ),
}))

function getScopedToolRegistry(session, options = {}) {
  const agentContext = getAgentRuntimeConfig().agentContext || {}
  const policy = toolsetPolicy.resolve({
    profile: session?.profile || session?.agentName || 'default',
    policy: {
      allowWrite: options.allowWrite !== false,
      allowSubagents: !session?.parentId && options.allowSubagents !== false,
      allowHandoff: options.allowHandoff !== false,
      allowDiagnostics: options.allowDiagnostics !== false,
      allowSkillRuntime: options.allowSkillRuntime !== false,
      allowCitation: options.allowCitation !== false,
      allowReview: options.allowReview !== false,
      allowCompile: options.allowCompile !== false,
      allowExec: options.allowExec !== false,
      allowWorkspaceSync: options.allowWorkspaceSync !== false,
      allowMemoryProposals: agentContext.enabled === true &&
        !session?.parentId &&
        options.allowMemoryProposals !== false,
    },
  })
  return toolRegistry.scoped(policy.tools)
}

// Skill registry (initialized asynchronously)
let skillRegistry = null

/**
 * Initialize async resources (skill registry, etc.)
 * Must be called after MongoDB connection is established.
 */
async function initialize() {
  skillRegistry = new SkillRegistry()
  await skillRegistry.loadAll()
  toolRegistry.register(new ActivateSkillTool(skillRegistry))
  toolRegistry.register(new ReadSkillReferenceTool(skillRegistry))
  toolRegistry.register(new RunSkillScriptTool({ skillRegistry }))

  agentTeamOrchestrator = new AgentTeamOrchestrator({
    store: agentTeamRunService.store,
    agentController: {
      createChildSession,
      updateSessionStatus,
    },
    parentToolRegistry: toolRegistry,
    skillRegistry,
  })

  toolRegistry.register(new StartAgentTaskTool({
    orchestrator: agentTeamOrchestrator,
  }))
  toolRegistry.register(new StartAgentTeamTool({
    orchestrator: agentTeamOrchestrator,
  }))
  toolRegistry.register(new HandoffToAgentTool({
    agentController: {
      createChildSession,
      updateSessionStatus,
    },
    parentToolRegistry: toolRegistry,
  }))
  toolRegistry.register(new ReturnFromHandoffTool({
    agentController: {
      createChildSession,
      updateSessionStatus,
    },
    parentToolRegistry: toolRegistry,
  }))

  const sysConfig = await getModelConfigService().getSystemConfig()
  if (!sysConfig) {
    logger.warn('No model config found in DB. Run: node scripts/seed-model-configs.js')
  }

  await reconcileInterruptedTurns()
}

function mergeSessionArtifacts(sessionArtifacts = [], artifactDocs = []) {
  const merged = new Map()
  for (const artifact of sessionArtifacts || []) {
    const id = artifact.id || artifact._id?.toString?.() || artifact._id
    if (!id) continue
    merged.set(id, {
      id,
      path: artifact.path,
      size: artifact.size,
    })
  }
  for (const artifact of artifactDocs || []) {
    const id = artifact._id?.toString?.() || artifact._id || artifact.id
    if (!id) continue
    merged.set(id, {
      id,
      path: artifact.path,
      size: artifact.size,
    })
  }
  return [...merged.values()]
}

/**
 * Create a new AI session
 */
async function createSession(req, res) {
  const { projectId, docId, title, profile, runtimeMode, model } = req.body
  const userId = req.headers['x-user-id'] || null

  if (!projectId) {
    throw new ValidationError('projectId is required')
  }

  if (docId && !DOC_ID_RE.test(docId)) {
    throw new ValidationError('Invalid docId format')
  }

  if (userId && !await _checkProjectAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const now = new Date()
  const session = {
    _id: new ObjectId(),
    projectId,
    userId,
    profile: typeof profile === 'string' && profile.trim()
      ? profile.trim()
      : 'default',
    runtimeMode: resolveDefaultSessionRuntimeMode(runtimeMode),
    model: typeof model === 'string' && model.trim() ? model.trim() : null,
    currentDocId: docId || null,
    title: sanitizeSessionTitle(title) || `New session - ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
    changeHistory: [],
    parentId: null,
    parentSessionId: null,
    rootSessionId: null, // will be set to own _id below
    agentName: null,
    workspaceId: null,
    _nextSeq: 1,
    _latestSummarySeq: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastTurnAt: null,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  }
  session.rootSessionId = session._id

  await db.aiSessions.insertOne(session)

  logger.info(
    { sessionId: session._id.toString(), projectId },
    'AI session created'
  )

  res.status(201).json({ session: serializeSession(session, []) })
}

const MAX_DELEGATION_DEPTH = new RunBudget().maxDepth

/**
 * Create a child session (internal, not exposed as API)
 * @param {object} options
 * @param {string} options.parentId - Parent session ID string
 * @param {string} options.projectId - Project ID
 * @param {string} options.userId - User ID
 * @param {string} options.agentName - Agent type name
 * @returns {Promise<object>} The child session document
 */
async function createChildSession({
  parentId,
  projectId,
  userId,
  agentName,
  requestedToolNames = [],
  allowedToolNames = [],
}) {
  const parentObjectId = new ObjectId(parentId)
  const parent = await db.aiSessions.findOne(
    { _id: parentObjectId },
    {
      projection: {
        rootSessionId: 1,
        parentId: 1,
        projectId: 1,
        userId: 1,
        runtimeMode: 1,
        model: 1,
      },
    }
  )

  if (!parent) {
    throw new SessionNotFoundError(parentId)
  }

  // Verify projectId and userId match the parent session to prevent cross-session hijacking
  if (parent.projectId !== projectId || parent.userId !== userId) {
    throw new ValidationError('projectId/userId mismatch with parent session')
  }

  // Check delegation depth by counting ancestor chain
  let depth = 1
  let current = parent
  while (current.parentId && depth < MAX_DELEGATION_DEPTH + 1) {
    depth++
    current = await db.aiSessions.findOne(
      { _id: current.parentId },
      { projection: { parentId: 1 } }
    )
    if (!current) break
  }

  if (depth > MAX_DELEGATION_DEPTH) {
    throw new ValidationError(`Maximum delegation depth (${MAX_DELEGATION_DEPTH}) exceeded`)
  }

  const childSession = {
    _id: new ObjectId(),
    projectId,
    userId,
    currentDocId: null,
    title: `子 Agent: ${agentName}`,
    changeHistory: [],
    parentId: parentObjectId,
    parentSessionId: parentObjectId,
    rootSessionId: parent.rootSessionId || parentObjectId,
    agentName,
    profile: agentName,
    runtimeMode: serializeRuntimeMode(parent.runtimeMode),
    model: parent.model || null,
    requestedToolNames: Array.from(new Set(requestedToolNames)),
    allowedToolNames: Array.from(new Set(allowedToolNames)),
    workspaceId: null,
    _nextSeq: 1,
    _latestSummarySeq: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    lastTurnAt: null,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  }

  await db.aiSessions.insertOne(childSession)

  logger.info(
    { sessionId: childSession._id.toString(), parentId, agentName, projectId },
    'Child AI session created'
  )

  return childSession
}

/**
 * Mark a child session as completed, stopped, or errored (internal)
 * @param {string} sessionId - Session ID string
 * @param {'completed'|'stopped'|'error'} status
 */
async function updateSessionStatus(sessionId, status) {
  await db.aiSessions.updateOne(
    { _id: new ObjectId(sessionId) },
    { $set: { status, updatedAt: new Date(), lastTurnAt: new Date() } }
  )
}

async function reconcileInterruptedTurns() {
  const now = new Date()
  const result = await db.aiSessions.updateMany(
    { 'activeTurn.status': 'running' },
    {
      $set: {
        'activeTurn.status': 'interrupted_after_restart',
        'activeTurn.reason': 'service_restart',
        'activeTurn.interruptedAt': now,
        _streamingInterrupted: true,
        updatedAt: now,
      },
    }
  )
  if (result.modifiedCount > 0) {
    logger.warn(
      { count: result.modifiedCount },
      'Reconciled active AI turns interrupted by service restart'
    )
  }
  return result
}

/**
 * List sessions for a project
 */
async function listSessions(req, res) {
  const { projectId } = req.query
  if (!projectId) {
    throw new ValidationError('projectId query parameter is required')
  }

  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    return res.status(400).json({ error: 'Invalid projectId' })
  }

  const userId = req.headers['x-user-id']
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId' })
  }

  const hasAccess = await _checkProjectAccess(projectId, userId)
  if (!hasAccess) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const sessions = await db.aiSessions
    .find(
      {
        projectId,
        userId,
        parentId: null,
        status: { $nin: ['ended', 'archived'] },
      },
      {
        projection: {
          _id: 1,
          projectId: 1,
          title: 1,
          profile: 1,
          runtimeMode: 1,
          model: 1,
          status: 1,
          parentId: 1,
          parentSessionId: 1,
          workspaceId: 1,
          createdAt: 1,
          updatedAt: 1,
          lastTurnAt: 1,
          expiresAt: 1,
        },
      }
    )
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray()

  res.json({
    sessions: sessions.map(serializeSessionSummary),
  })
}

/**
 * Get session status
 */
async function getSession(req, res) {
  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  // Pagination parameters
  // When limit is not explicitly provided, return all messages (backward compatible).
  // Only paginate when the caller explicitly passes a limit parameter.
  const limitParam = typeof req.query.limit === 'string' ? req.query.limit : null
  const rawLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN
  const hasExplicitLimit = Number.isFinite(rawLimit) && rawLimit > 0
  const rawBeforeSeq = typeof req.query.beforeSeq === 'string'
    ? Number.parseInt(req.query.beforeSeq, 10)
    : NaN
  const beforeSeq = Number.isFinite(rawBeforeSeq) && rawBeforeSeq > 0 ? rawBeforeSeq : null
  const DEFAULT_SESSION_PAGE_SIZE = settings.aiAssistant?.sessionPageSize || 200
  const MAX_SESSION_PAGE_SIZE = settings.aiAssistant?.sessionPageMax || 500
  const limit = hasExplicitLimit
    ? Math.min(rawLimit, MAX_SESSION_PAGE_SIZE)
    : beforeSeq
      ? DEFAULT_SESSION_PAGE_SIZE
      : null

  // Load messages: prefer aiMessages collection, fall back to embedded for unmigrated sessions
  let messages
  let hasMore = false
  if (session._nextSeq && session._nextSeq > 1) {
    const filter = { sessionId: session._id }
    if (beforeSeq) {
      filter.seq = { $lt: beforeSeq }
    }
    if (limit) {
      // Explicit pagination: fetch limit+1 to detect hasMore
      messages = await db.aiMessages
        .find(filter)
        .sort({ seq: -1 })
        .limit(limit + 1)
        .toArray()
      if (messages.length > limit) {
        hasMore = true
        messages = messages.slice(0, limit)
      }
    } else {
      // No limit: return all messages (backward compatible)
      messages = await db.aiMessages
        .find(filter)
        .sort({ seq: -1 })
        .toArray()
    }
    messages.reverse()
  } else if (session.messages?.length) {
    // Unmigrated session: use embedded messages
    messages = session.messages

    const hasSeq = Number.isFinite(messages[0]?.seq)
    if (beforeSeq && hasSeq) {
      messages = messages.filter(msg => msg.seq < beforeSeq)
    }

    if (limit && hasSeq && messages.length > limit) {
      hasMore = true
      messages = messages.slice(messages.length - limit)
    }
  } else {
    messages = []
  }

  let nextBeforeSeq = null
  if (hasMore && messages.length > 0 && Number.isFinite(messages[0]?.seq)) {
    nextBeforeSeq = messages[0].seq
  } else if (hasMore) {
    // No stable seq to paginate on (legacy messages) — disable pagination signals.
    hasMore = false
  }

  const [toolCalls, changeSets, workspace, artifacts] = await Promise.all([
    agentMessageStore.listToolCalls(session._id),
    agentChangeSetService.listChangeSets({
      sessionId: session._id,
      projectId: session.projectId,
      userId: session.userId,
    }),
    session.workspaceId
      ? db.aiAgentWorkspaces.findOne(
        { _id: session.workspaceId },
        { projection: { status: 1, lastDrift: 1, updatedAt: 1 } }
      )
      : null,
    db.aiSandboxArtifacts
      .find(
        {
          sessionId: session._id.toString(),
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: new Date() } },
          ],
        },
        { projection: { _id: 1, path: 1, size: 1, createdAt: 1 } }
      )
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
  ])
  session.workspaceDrift = workspace?.lastDrift || session.workspaceDrift || null
  session.workspaceStatus = workspace?.status || session.workspaceStatus || null
  session.workspaceUpdatedAt = workspace?.updatedAt || session.workspaceUpdatedAt || null
  session.artifacts = mergeSessionArtifacts(session.artifacts, artifacts)
  const serialized = serializeSession(
    session,
    serializeMessages(messages),
    changeSets.map(({ changeSet, draftChanges }) =>
      serializeChangeSet(changeSet, draftChanges)
    )
  )
  serialized.toolCalls = serializeToolCalls(toolCalls)
  serialized.hasMore = hasMore
  serialized.nextBeforeSeq = nextBeforeSeq
  res.json({ session: serialized })
}

async function listTeamRuns(req, res) {
  const session = await _loadAndAuthorizeSession(req, res, { allowTerminal: true })
  if (!session) return
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const teamRuns = await agentTeamRunService.listTeamRuns({
    session,
    userId: req.headers['x-user-id'],
    status,
  })
  res.json({ teamRuns })
}

async function getTeamRun(req, res) {
  const session = await _loadAndAuthorizeSession(req, res, { allowTerminal: true })
  if (!session) return
  const teamId = normalizeObjectIdString(req.params.teamId, 'teamId')
  const teamRun = await agentTeamRunService.getTeamRun({
    session,
    userId: req.headers['x-user-id'],
    teamId,
  })
  if (!teamRun) return res.status(404).json({ error: 'Team run not found' })
  res.json({ teamRun })
}

async function cancelTeamRun(req, res) {
  const session = await _loadAndAuthorizeSession(req, res, { allowTerminal: true })
  if (!session) return
  const teamId = normalizeObjectIdString(req.params.teamId, 'teamId')
  const reason =
    typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().slice(0, 120)
      : 'user-cancelled'
  const existingTeamRun = await agentTeamRunService.getTeamRun({
    session,
    userId: req.headers['x-user-id'],
    teamId,
  })
  if (!existingTeamRun) return res.status(404).json({ error: 'Team run not found' })
  const stoppedSessionIds = await stopActiveSessionTree(session)
  const teamRun = await agentTeamRunService.cancelTeamRun({
    session,
    userId: req.headers['x-user-id'],
    teamId,
    reason,
  })
  if (!teamRun) return res.status(404).json({ error: 'Team run not found' })
  res.json({ teamRun, stoppedSessionIds })
}

async function retryTeamRunTask(req, res) {
  const session = await _loadAndAuthorizeSession(req, res, { allowTerminal: true })
  if (!session) return
  const teamId = normalizeObjectIdString(req.params.teamId, 'teamId')
  const taskId = normalizeObjectIdString(req.params.taskId, 'taskId')
  try {
    const result = await agentTeamRunService.retryTask({
      session,
      userId: req.headers['x-user-id'],
      teamId,
      taskId,
    })
    if (!result) return res.status(404).json({ error: 'Team run not found' })
    res.status(202).json(result)
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({ error: error.message })
    }
    if (error.statusCode === 409) {
      return res.status(409).json({ error: error.message })
    }
    if (error.statusCode === 501) {
      return res.status(501).json({ error: error.message })
    }
    throw error
  }
}

async function retryAgentTeamTask({ session, userId, team, sourceTask, retryTask }) {
  if (!agentTeamOrchestrator) {
    const error = new Error('Task retry runner is not initialized')
    error.statusCode = 501
    throw error
  }
  const slot = (await getModelConfigService().getSystemConfig())?.defaultSlot
  if (!slot) {
    throw new Error('No model configuration found. Admin must configure models first.')
  }
  const resolved = await getModelConfigService().resolveSlot(slot)
  const result = await agentTeamOrchestrator.runTaskInTeam({
    sessionId: session._id.toString(),
    rootSessionId: team.rootSessionId?.toString?.() || session._id.toString(),
    projectId: session.projectId,
    userId,
    team,
    task: retryTask,
    taskSpec: {
      capabilityName: retryTask.agentName,
      capabilityVersion: retryTask.agentVersion,
      mode: retryTask.mode,
      objective: retryTask.objective,
      acceptanceCriteria: retryTask.acceptanceCriteria || [],
      input: {
        ...(retryTask.input || {}),
        retryOfTaskId: sourceTask._id.toString(),
      },
      outputSchema: retryTask.outputSchema || { type: 'object' },
      policy: retryTask.policy || {},
      timeoutMs: retryTask.timeoutMs || undefined,
      retryPolicy: retryTask.retryPolicy || {},
    },
    parentPolicy: team.policySummary || {},
    sessionState: {},
    llmAdapter: resolved.adapter,
    adapters: buildAgentLoopAdapters(resolved.adapter),
    persistentWorkspace: null,
    agentMessageStore,
    activeChangeSetId: team.rootChangeSetId || null,
    disablePersistence: false,
  })
  const refreshedRun = await agentTeamRunService.store.loadTeamRun({
    teamId: team._id,
    projectId: session.projectId,
    userId,
  })
  const teamStatus = summarizeTeamStatusAfterRetry(refreshedRun)
  await agentTeamRunService.store.completeTeamRun?.({
    teamId: team._id,
    projectId: session.projectId,
    userId,
    status: teamStatus,
  })
  await agentTeamRunService.store.recordEvent({
    teamId: team._id,
    taskId: retryTask._id,
    sessionId: session._id,
    type: 'agent_task.retry_completed',
    payload: {
      sourceTaskId: sourceTask._id.toString(),
      retryTaskId: retryTask._id.toString(),
      status: result.status,
    },
  })
  return result
}

function summarizeTeamStatusAfterRetry(loaded) {
  const tasks = loaded?.tasks || []
  if (tasks.some(task => task.status === 'running' || task.status === 'queued')) {
    return 'running'
  }
  if (tasks.some(task => task.status === 'failed' || task.status === 'timeout')) {
    return tasks.some(task => task.status === 'completed') ? 'degraded' : 'failed'
  }
  return 'completed'
}

/**
 * Update session (rename)
 */
async function updateSession(req, res) {
  const { sessionId } = req.params
  const { title } = req.body
  const sanitizedTitle = sanitizeSessionTitle(title)
  if (!sanitizedTitle) {
    throw new ValidationError('title is required and must be a non-empty string')
  }

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  const result = await db.aiSessions.updateOne(
    { _id: session._id },
    { $set: { title: sanitizedTitle, updatedAt: new Date() } }
  )
  if (result.matchedCount === 0) throw new SessionNotFoundError(sessionId)

  res.json({ success: true, title: sanitizedTitle })
}

/**
 * Upload an image attachment to a session
 */
async function uploadAttachment(req, res) {
  const { sessionId } = req.params
  const file = req.file
  const userId = req.headers['x-user-id'] || null

  if (!file) {
    throw new ValidationError('No file uploaded')
  }

  try {
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

    if (!allowedMimes.includes(file.mimetype)) {
      throw new ValidationError(`Unsupported file type: ${file.mimetype}`)
    }

    // Validate session ownership (defence-in-depth: requireUserId ensures userId exists)
    const session = await findSession(sessionId)
    if (!userId || !session.userId || session.userId !== userId) {
      throw new ValidationError('Session does not belong to this user')
    }

    const attachmentId = new ObjectId()

    // Upload to filestore via web internal API
    const { storageKey } = await fileStoreAdapter.uploadAttachment(file.path, {
      userId,
      sessionId,
      attachmentId: attachmentId.toString(),
      filename: file.originalname,
      mimeType: file.mimetype,
    })

    // Save metadata to aiAttachments collection
    const attachmentDoc = {
      _id: attachmentId,
      sessionId: session._id,
      userId,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      storageKey,
      expiresAt: new Date(Date.now() + REFERENCED_TTL_MS),
      createdAt: new Date(),
    }

    try {
      await db.aiAttachments.insertOne(attachmentDoc)
    } catch (dbErr) {
      // Rollback: delete the already-uploaded file from filestore
      try { await fileStoreAdapter.deleteAttachment(storageKey, userId) } catch (rollbackErr) {
        logger.warn({ storageKey, err: rollbackErr.message }, 'Failed to rollback filestore upload after DB error')
      }
      throw dbErr
    }

    logger.info(
      { sessionId, attachmentId: attachmentId.toString(), filename: file.originalname },
      'Attachment uploaded'
    )

    res.status(201).json({
      id: attachmentId.toString(),
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    })
  } finally {
    // Always cleanup temp file
    await safeUnlink(file.path)
  }
}

/**
 * Get (download) an attachment from a session
 */
async function getAttachment(req, res) {
  const { sessionId, attachmentId } = req.params
  const userId = req.headers['x-user-id'] || null

  // Validate session exists
  const session = await findSession(sessionId)

  // Ownership check: reject if no userId, or session has no owner, or owner mismatch
  if (!userId || !session.userId || session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' })
  }

  let attachmentObjectId
  try {
    attachmentObjectId = new ObjectId(attachmentId)
  } catch {
    throw new ValidationError('Invalid attachment ID format')
  }

  // Find attachment and verify it belongs to this session
  const attachment = await db.aiAttachments.findOne({
    _id: attachmentObjectId,
    sessionId: session._id,
  })

  if (!attachment) {
    return res.status(404).json({ error: 'Attachment not found' })
  }

  // Download from filestore
  let buffer
  try {
    buffer = await fileStoreAdapter.downloadAttachment(attachment.storageKey, userId)
  } catch (err) {
    logger.warn({ storageKey: attachment.storageKey, err: err.message }, 'Failed to download attachment from filestore')
    return res.status(err.info?.status === 404 ? 404 : 500).json({
      error: err.info?.status === 404 ? 'Attachment file not found in storage' : 'Failed to download attachment',
    })
  }

  res.setHeader('Content-Type', attachment.mimeType)
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('Content-Disposition', 'attachment')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.send(buffer)
}

/**
 * Download a workspace artifact produced by an AgentLoop tool.
 */
async function getSessionArtifact(req, res) {
  const { sessionId, artifactId } = req.params
  const userId = req.headers['x-user-id'] || null

  const session = await findSession(sessionId)
  if (!userId || !session.userId || session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const artifact = await db.aiSandboxArtifacts.findOne({
    _id: artifactId,
    sessionId: session._id.toString(),
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: new Date() } },
    ],
  })
  if (!artifact) {
    return res.status(404).json({ error: 'Artifact not found' })
  }

  const content = Buffer.isBuffer(artifact.content)
    ? artifact.content
    : Buffer.from(artifact.content?.buffer || artifact.content || '')
  const filename = path.basename(artifact.path || 'artifact')
  const mimeType = inferArtifactMimeType(filename)

  res.setHeader('Content-Type', mimeType)
  res.setHeader('Content-Length', content.length)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename)}"`
  )
  res.send(content)
}

function inferArtifactMimeType(filename) {
  if (/\.pdf$/i.test(filename)) return 'application/pdf'
  if (/\.(log|aux|fls|fdb_latexmk|txt)$/i.test(filename)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

/**
 * Upload a file independently (no session required)
 */
async function uploadFile(req, res) {
  const file = req.file
  const userId = req.headers['x-user-id'] || null

  if (!file) throw new ValidationError('No file uploaded')
  if (!userId) {
    await safeUnlink(file.path)
    throw new ValidationError('userId is required')
  }

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

  if (!allowedMimes.includes(file.mimetype)) {
    await safeUnlink(file.path)
    throw new ValidationError(`Unsupported file type: ${file.mimetype}`)
  }

  const fileId = new ObjectId()

  try {
    const { storageKey } = await fileStoreAdapter.uploadAttachment(file.path, {
      userId,
      sessionId: null,
      attachmentId: fileId.toString(),
      filename: file.originalname,
      mimeType: file.mimetype,
    })

    try {
      await db.aiFiles.insertOne({
        _id: fileId,
        userId,
        sessionId: null,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        storageKey,
        purpose: 'chat',
        expiresAt: new Date(Date.now() + UNREFERENCED_TTL_MS),
        createdAt: new Date(),
      })
    } catch (dbErr) {
      // Rollback: delete the already-uploaded file from filestore
      try { await fileStoreAdapter.deleteAttachment(storageKey, userId) } catch (rollbackErr) {
        logger.warn({ storageKey, err: rollbackErr.message }, 'Failed to rollback filestore upload after DB error')
      }
      throw dbErr
    }

    logger.info(
      { fileId: fileId.toString(), filename: file.originalname },
      'File uploaded independently'
    )

    res.status(201).json({
      id: fileId.toString(),
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    })
  } finally {
    await safeUnlink(file.path)
  }
}

/**
 * Get (download) a file by ID (no session required)
 */
async function getFile(req, res) {
  const { fileId } = req.params
  const userId = req.headers['x-user-id'] || null

  let objectId
  try { objectId = new ObjectId(fileId) } catch {
    throw new ValidationError('Invalid file ID format')
  }

  // Try aiFiles first, fallback to aiAttachments (legacy data)
  let fileDoc = await db.aiFiles.findOne({ _id: objectId })
  if (!fileDoc) {
    fileDoc = await db.aiAttachments.findOne({ _id: objectId })
  }
  if (!fileDoc) return res.status(404).json({ error: 'File not found' })

  // Ownership check: reject if file has no owner (legacy data with null userId)
  // or if the owner doesn't match the requesting user
  if (!fileDoc.userId || fileDoc.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' })
  }

  let buffer
  try {
    buffer = await fileStoreAdapter.downloadAttachment(fileDoc.storageKey, userId)
  } catch (err) {
    logger.warn({ storageKey: fileDoc.storageKey, err: err.message }, 'Failed to download file from filestore')
    return res.status(err.info?.status === 404 ? 404 : 500).json({
      error: err.info?.status === 404 ? 'File not found in storage' : 'Failed to download file',
    })
  }
  res.setHeader('Content-Type', fileDoc.mimeType)
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Use inline disposition for images so browsers render them in <img> tags;
  // use attachment for non-image types to force download.
  const disposition = fileDoc.mimeType?.startsWith('image/') ? 'inline' : 'attachment'
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(fileDoc.filename || 'file')}"`)
  res.send(buffer)
}

/**
 * Archive a session.
 *
 * The route remains DELETE for frontend compatibility, but the persistence
 * semantics are intentionally soft-delete: messages, attachments, and child
 * sessions remain available for diagnostics while active APIs return 410.
 */
async function deleteSession(req, res) {
  const { sessionId } = req.params

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  await stopActiveSessionTree(session)
  const childSessions = await db.aiSessions
    .find(
      { rootSessionId: session._id, _id: { $ne: session._id } },
      { projection: { _id: 1 } }
    )
    .toArray()
  const childIds = childSessions.map(s => s._id)
  for (const childId of childIds) {
    const childIdString = childId.toString()
    const childLoop = activeAgentLoops.get(childIdString)
    if (childLoop) {
      try { childLoop.stop() } catch {}
      activeAgentLoops.delete(childIdString)
    }
    const childChannel = activeChannels.get(childIdString)
    if (childChannel) {
      try { childChannel.abort() } catch {}
      activeChannels.delete(childIdString)
    }
  }

  const now = new Date()
  const result = await db.aiSessions.updateMany(
    { _id: { $in: [session._id, ...childIds] } },
    {
      $set: {
        status: 'archived',
        archivedAt: now,
        updatedAt: now,
      },
    }
  )
  if (result.matchedCount === 0) {
    throw new SessionNotFoundError(sessionId)
  }

  logger.info({ sessionId, childCount: childIds.length }, 'AI session archived')

  res.status(204).send()
}

/**
 * Send a message and get AI response
 */
async function sendMessage(req, res) {
  const { sessionId } = req.params
  const { content, context, stream, resume, fileIds, attachmentIds, modelSlot } = req.body
  if (context?.currentDocId && !DOC_ID_RE.test(context.currentDocId)) {
    throw new ValidationError('Invalid currentDocId format')
  }
  const effectiveFileIds = fileIds || attachmentIds

  if (!resume && !content) {
    throw new ValidationError('content is required')
  }

  const session = await findSession(sessionId, {
    projection: { _streamingContext: 1, _readDocuments: 1, projectId: 1, userId: 1, rootSessionId: 1, parentId: 1, profile: 1, agentName: 1, status: 1, changeHistory: 1, runtimeMode: 1, model: 1, workspaceId: 1, _id: 1 },
  })

  const userId = req.headers['x-user-id']
  if (!session.userId || session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' })
  }

  // Re-check project access (user may have been removed from the project)
  const hasAccess = await _checkProjectAccess(session.projectId, userId)
  if (!hasAccess) {
    return res.status(403).json({ error: 'Access to project denied' })
  }

  // Per-session mutex: check before deciding streaming vs non-streaming
  const mutexSessionId = session._id.toString()
  if (activeAgentLoops.has(mutexSessionId)) {
    return res.status(409).json({
      error: 'SESSION_BUSY',
      message: 'This session already has an active agent loop. Please stop it first or wait for it to complete.',
    })
  }

  // Reject resume when there is no streaming context to resume from
  if (resume && (!session._streamingContext || session._streamingContext.length === 0)) {
    return res.status(409).json({ error: 'No streaming context to resume, please refresh session' })
  }

  // Check if streaming requested (via body param or Accept header)
  const isStreamRequested = stream || req.headers.accept?.includes('text/event-stream')
  if (isStreamRequested) {
    return sendStreamingMessage(req, res, session, content, context, { resume: !!resume, fileIds: effectiveFileIds, modelSlot })
  }

  // Non-streaming response
  const runBudget = new RunBudget()
  const messageId = new ObjectId().toString()

  // --- Dynamic model resolution ---
  let requestLLMAdapter, modelCapabilities, modelInfoSnapshot

  const slotToResolve = modelSlot || (await getModelConfigService().getSystemConfig())?.defaultSlot
  if (slotToResolve) {
    try {
      const resolved = await getModelConfigService().resolveSlot(slotToResolve)
      requestLLMAdapter = resolved.adapter
      modelCapabilities = { supportsImage: resolved.config.supportsImage }
      modelInfoSnapshot = {
        slotSlug: resolved.slot.slug,
        slotLabel: resolved.slot.label,
        modelConfigId: resolved.config._id.toString(),
        modelName: resolved.config.model,
      }
    } catch (err) {
      logger.warn({ modelSlot: slotToResolve, err: err.message }, 'Failed to resolve model slot')
      return res.status(400).json({ error: 'INVALID_MODEL_SLOT', message: `Model slot "${slotToResolve}" could not be resolved` })
    }
  } else {
    return res.status(500).json({ error: 'NO_MODEL_CONFIGURED', message: 'No model configuration found. Admin must configure models first.' })
  }

  const effectiveUserId = userId || session.userId || null
  const persistentWorkspace = await ensurePersistentWorkspaceForSession(
    session,
    effectiveUserId
  )

  const agentLoop = createAgentLoopForSession(session, {
    sessionId: session._id.toString(),
    projectId: session.projectId,
    llmAdapter: requestLLMAdapter,
    toolRegistry: getScopedToolRegistry(session),
    contextManager,
    adapters: buildAgentLoopAdapters(requestLLMAdapter),
    // Pass context for current document info
    currentDocId: context?.currentDocId,
    currentDocPath: context?.currentDocPath,
    userId: effectiveUserId,
    profile: session.profile,
    agentName: session.agentName,
    model: session.model || modelInfoSnapshot?.modelName || null,
    runBudget,
  })
  logger.info(
    {
      sessionId: session._id.toString(),
      projectId: session.projectId,
      runtimeMode: agentLoop.runtimeMode,
      agentLoopPath: agentLoop.agentLoopPath,
      streaming: false,
      resume: false,
      parentSessionId: session.parentId?.toString?.() || null,
      rootSessionId: session.rootSessionId?.toString?.() || session._id.toString(),
    },
    'AI agent loop selected'
  )

  // Register in activeAgentLoops for mutual exclusion (same as streaming path)
  activeAgentLoops.set(mutexSessionId, agentLoop)

  let responseContent = ''
  let truncated = false
  const toolResults = []

  // Collect tool interaction messages for persistence
  const toolContextMessages = []
  let currentNsTurnToolCalls = []
  let currentNsTurnToolResults = []
  let currentNsTurnAssistantContent = ''
  let finalReadDocuments = null

  try {
    // Load persisted readDocuments into context
    const initialReadDocuments = new Map()
    if (session._readDocuments) {
      for (const [key, value] of Object.entries(session._readDocuments)) {
        initialReadDocuments.set(key, value)
      }
    }
    const enrichedNsContext = {
      ...(context || {}),
      _initialReadDocuments: initialReadDocuments,
      _fileStoreAdapter: fileStoreAdapter,
      _modelCapabilities: modelCapabilities,
      _userId: effectiveUserId,
        _persistentWorkspace: persistentWorkspace,
    }

    // Load files if provided
    if (effectiveFileIds && effectiveFileIds.length > 0) {
      const files = await _loadVerifiedFiles(effectiveFileIds, session._id, effectiveUserId)
      if (files.length > 0) {
        enrichedNsContext._attachments = files
      }
    }

    // Refresh TTL for all files associated with this session (both collections)
    // This mirrors the TTL refresh in the streaming path.
    const ttlRefresh = { $set: { expiresAt: new Date(Date.now() + REFERENCED_TTL_MS) } }
    await Promise.all([
      db.aiFiles.updateMany(
        { sessionId: session._id },
        ttlRefresh
      ).catch(err => logger.warn({ err }, 'Failed to refresh aiFiles TTL (non-streaming)')),
      db.aiAttachments.updateMany(
        { sessionId: session._id },
        ttlRefresh
      ).catch(err => logger.warn({ err }, 'Failed to refresh aiAttachments TTL (non-streaming)')),
    ])

    // Run agent loop and collect all events
    for await (const event of agentLoop.run(content, enrichedNsContext)) {
      // Filter out child session events — only process main session events
      const eventSessionId = event.sessionId || session._id.toString()
      const isMainSession = eventSessionId === session._id.toString()

      if (event.type === 'text') {
        if (isMainSession) {
          // Guard: stop agent loop if accumulated content exceeds safe limit
          if (responseContent.length + event.content.length > MAX_MESSAGE_CHARS) {
            logger.warn(
              { sessionId: session._id.toString(), responseContentLength: responseContent.length, limit: MAX_MESSAGE_CHARS },
              'Non-streaming content limit exceeded, stopping agent loop'
            )
            truncated = true
            agentLoop.stop()
            break
          }
          responseContent += event.content
          currentNsTurnAssistantContent += event.content
        }
      } else if (event.type === 'tool_call') {
        if (isMainSession) {
          currentNsTurnToolCalls.push(event.toolCall)
          await agentMessageStore.startToolCall({
            sessionId: session._id,
            messageId,
            toolCall: event.toolCall,
            queued: event.queued || false,
          })
        }
      } else if (event.type === 'tool_result') {
        if (isMainSession) {
          await agentMessageStore.finishToolCall({
            sessionId: session._id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
          })
          toolResults.push({
            toolName: event.toolName,
            success: event.result.success,
          })
          // Collect for toolContext
          currentNsTurnToolResults.push({
            toolCallId: event.toolCallId,
            content: event.result.output || JSON.stringify(event.result),
          })
          if (currentNsTurnToolCalls.length > 0 && currentNsTurnToolResults.length === currentNsTurnToolCalls.length) {
            pushToolContext(toolContextMessages, {
              role: 'assistant',
              content: currentNsTurnAssistantContent || null,
              tool_calls: currentNsTurnToolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.function?.name, arguments: tc.function?.arguments },
              })),
            })
            for (const tr of currentNsTurnToolResults) {
              pushToolContext(toolContextMessages, { role: 'tool', tool_call_id: tr.toolCallId, content: tr.content })
            }
            currentNsTurnAssistantContent = ''
            currentNsTurnToolCalls = []
            currentNsTurnToolResults = []
          }
        }
      } else if (event.type === 'done') {
        if (isMainSession && event.readDocuments) {
          finalReadDocuments = event.readDocuments
        }
      }
      // awaiting_confirmation, change_confirmed, etc. are
      // silently ignored in non-streaming mode (no confirmation channel)
    }

    // Save messages to aiMessages collection
    const startSeq = await allocateSeq(session._id, 2)
    const now = new Date()
    await db.aiMessages.insertMany([
      { sessionId: session._id, seq: startSeq, role: 'user', content,
        ...(enrichedNsContext._attachments?.length > 0 && {
          attachments: enrichedNsContext._attachments.map(a => ({
            id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, storageKey: a.storageKey,
          })),
        }),
        timestamp: now },
      {
        sessionId: session._id,
        seq: startSeq + 1,
        role: 'assistant',
        content: responseContent,
        toolContext: toolContextMessages.length > 0 ? toolContextMessages : undefined,
        ...(truncated && { truncated: true }),
        timestamp: now,
      },
    ])
    await db.aiSessions.updateOne(
      { _id: session._id },
      {
        $set: {
          updatedAt: now,
          lastTurnAt: now,
          ...(finalReadDocuments && finalReadDocuments.size > 0 && {
            _readDocuments: Object.fromEntries(finalReadDocuments),
          }),
        },
      }
    )

    res.json({
      response: responseContent,
      toolResults,
      truncated,
      modelInfo: modelInfoSnapshot || undefined,
    })
  } finally {
    activeAgentLoops.delete(mutexSessionId)
  }
}

/**
 * Send streaming message response
 */
async function sendStreamingMessage(req, res, session, content, context, options = {}) {
  const userId = req.headers['x-user-id'] || session.userId || null
  const sessionId = session._id.toString()

  // Per-session mutex: reject if this session already has an active agent loop
  if (activeAgentLoops.has(sessionId)) {
    return res.status(409).json({
      error: 'SESSION_BUSY',
      message: 'This session already has an active agent loop. Please stop it first or wait for it to complete.',
    })
  }

  // Per-user concurrent session limit (only root sessions)
  if (userId && !session.parentId) {
    const userSessions = activeRootSessionsByUser.get(userId)
    if (userSessions && userSessions.size >= MAX_USER_CONCURRENT_SESSIONS) {
      return res.status(429).json({
        error: 'USER_CONCURRENCY_LIMIT',
        message: `You can have at most ${MAX_USER_CONCURRENT_SESSIONS} concurrent AI sessions.`,
        limit: MAX_USER_CONCURRENT_SESSIONS,
      })
    }
  }

  // Create per-request budget for limiting total LLM calls, tokens, and wall time
  const runBudget = new RunBudget()

  // --- Dynamic model resolution (must be before SSE headers so we can return JSON errors) ---
  let requestLLMAdapter, modelCapabilities, modelInfoSnapshot

  const slotToResolve = options.modelSlot || (await getModelConfigService().getSystemConfig())?.defaultSlot
  if (slotToResolve) {
    try {
      const resolved = await getModelConfigService().resolveSlot(slotToResolve)
      requestLLMAdapter = resolved.adapter
      modelCapabilities = { supportsImage: resolved.config.supportsImage }
      modelInfoSnapshot = {
        slotSlug: resolved.slot.slug,
        slotLabel: resolved.slot.label,
        modelConfigId: resolved.config._id.toString(),
        modelName: resolved.config.model,
      }
    } catch (err) {
      logger.warn({ modelSlot: slotToResolve, err: err.message }, 'Failed to resolve model slot')
      return res.status(400).json({ error: 'INVALID_MODEL_SLOT', message: `Model slot "${slotToResolve}" could not be resolved` })
    }
  } else {
    return res.status(500).json({ error: 'NO_MODEL_CONFIGURED', message: 'No model configuration found. Admin must configure models first.' })
  }

  const persistentWorkspace = await ensurePersistentWorkspaceForSession(
    session,
    userId
  )

  // Set up SSE headers (must be after mutex check — can't send JSON after SSE headers)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  // Create confirmation channel for synchronous edit flow
  const confirmationChannel = new ConfirmationChannel()
  activeChannels.set(sessionId, confirmationChannel)

  const agentLoop = createAgentLoopForSession(session, {
    sessionId,
    projectId: session.projectId,
    llmAdapter: requestLLMAdapter,
    toolRegistry: getScopedToolRegistry(session),
    contextManager,
    adapters: buildAgentLoopAdapters(requestLLMAdapter),
    currentDocId: context?.currentDocId,
    currentDocPath: context?.currentDocPath,
    userId,
    profile: session.profile,
    agentName: session.agentName,
    model: session.model || modelInfoSnapshot?.modelName || null,
    confirmationChannel,
    rootSessionId: session.rootSessionId?.toString() || sessionId,
    runBudget,
    depth: 0,
  })
  logger.info(
    {
      sessionId,
      projectId: session.projectId,
      runtimeMode: agentLoop.runtimeMode,
      agentLoopPath: agentLoop.agentLoopPath,
      streaming: true,
      resume: !!options.resume,
      parentSessionId: session.parentId?.toString?.() || null,
      rootSessionId: session.rootSessionId?.toString?.() || sessionId,
    },
    'AI agent loop selected'
  )

  activeAgentLoops.set(sessionId, agentLoop)

  // Track per-user root sessions for concurrency limit
  if (userId && !session.parentId) {
    if (!activeRootSessionsByUser.has(userId)) {
      activeRootSessionsByUser.set(userId, new Set())
    }
    activeRootSessionsByUser.get(userId).add(sessionId)
  }

  let fullContent = ''
  const messageId = new ObjectId().toString()
  const contentBlocks = []
  const toolCallBlockMap = new Map() // toolCallId -> block reference for O(1) lookup
  let finalReadDocuments = null

  // Incremental streaming context tracking
  let currentTurnToolCalls = []
  let currentTurnToolResults = []
  let currentTurnAssistantContent = ''

  // Collect complete tool interaction messages for persistence (toolContext)
  const toolContextMessages = []

  // Helper to send SSE event with proper format for frontend
  let connectionAlive = true
  let disconnectedByClient = false
  let streamInterrupted = false
  const markStreamInterrupted = () => { streamInterrupted = true }
  let backpressureCount = 0
  let drainChain = Promise.resolve()
  const BACKPRESSURE_LIMIT = settings.aiAssistant?.backpressureLimit || 50
  const DRAIN_TIMEOUT_MS = settings.aiAssistant?.drainTimeoutMs || 5000
  const SSE_QUEUE_LIMIT = settings.aiAssistant?.maxSseQueue || 200
  let queuedEvents = 0
  const waitForDrain = () => new Promise((resolve) => {
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      res.removeListener('drain', onDrain)
      req.removeListener('close', onClose)
      clearTimeout(timeoutId)
      resolve(result)
    }
    const onDrain = () => settle('drain')
    const onClose = () => settle('close')
    const timeoutId = setTimeout(() => settle('timeout'), DRAIN_TIMEOUT_MS)
    res.once('drain', onDrain)
    req.once('close', onClose)
  })
  const sendEvent = (event) => {
    if (!connectionAlive) return
    if (queuedEvents >= SSE_QUEUE_LIMIT) {
      logger.warn(
        { sessionId, queuedEvents, limit: SSE_QUEUE_LIMIT },
        'SSE queue limit exceeded, disconnecting slow client'
      )
      connectionAlive = false
      markStreamInterrupted()
      if (agentLoop && !agentLoop.stopRequested) {
        agentLoop.stop()
      }
      res.end()
      return
    }
    queuedEvents += 1
    drainChain = drainChain
      .then(async () => {
        if (!connectionAlive) return
        try {
          const ok = res.write(`data: ${JSON.stringify(event)}\n\n`)
          if (!ok) {
            backpressureCount++
            logger.warn(
              { sessionId, backpressureCount },
              'SSE backpressure detected, client too slow'
            )
            if (backpressureCount > BACKPRESSURE_LIMIT) {
              logger.warn(
                { sessionId, backpressureCount },
                'SSE backpressure limit exceeded, disconnecting slow client'
              )
              connectionAlive = false
              markStreamInterrupted()
              if (agentLoop && !agentLoop.stopRequested) {
                agentLoop.stop()
              }
              res.end()
            } else {
              const outcome = await waitForDrain()
              if (outcome === 'timeout' || outcome === 'close') {
                connectionAlive = false
                markStreamInterrupted()
                if (agentLoop && !agentLoop.stopRequested) {
                  agentLoop.stop()
                }
                if (outcome === 'timeout') {
                  logger.warn({ sessionId, timeoutMs: DRAIN_TIMEOUT_MS }, 'SSE drain timeout, disconnecting')
                  res.end()
                }
              }
            }
          } else {
            // Reset counter when write succeeds without backpressure
            backpressureCount = 0
          }
        } catch {
          connectionAlive = false
          markStreamInterrupted()
          if (agentLoop && !agentLoop.stopRequested) {
            agentLoop.stop()
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        queuedEvents = Math.max(queuedEvents - 1, 0)
      })
  }
  const heartbeatTimer = setInterval(() => {
    sendEvent({
      type: 'heartbeat',
      timestamp: Date.now(),
      messageId,
      sessionId,
    })
  }, SSE_HEARTBEAT_MS)

  req.on('close', () => {
    connectionAlive = false
    disconnectedByClient = true
    markStreamInterrupted()
    if (agentLoop && !agentLoop.stopRequested) {
      agentLoop.stop()
    }
  })

  res.on('error', () => {
    connectionAlive = false
    markStreamInterrupted()
    if (agentLoop && !agentLoop.stopRequested) {
      agentLoop.stop()
    }
  })

  try {
    // Pre-load files so metadata can be persisted with user message
    let loadedFiles = []
    if (options.fileIds && options.fileIds.length > 0) {
      loadedFiles = await _loadVerifiedFiles(options.fileIds, session._id, userId)
    }

    // Save user message + initialize _streamingContext (normal mode only)
    if (!options.resume) {
      const userSeq = await allocateSeq(session._id, 1)
      await db.aiMessages.insertOne({
        sessionId: session._id,
        seq: userSeq,
        role: 'user',
        content,
        ...(loadedFiles.length > 0 && {
          attachments: loadedFiles.map(a => ({
            id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size, storageKey: a.storageKey,
          })),
        }),
        timestamp: new Date(),
      })
      await db.aiSessions.updateOne(
        { _id: session._id },
        {
          $set: {
            _streamingContext: [],
            activeTurn: {
              id: messageId,
              status: 'running',
              startedAt: new Date(),
              resumed: false,
              runtimeMode: agentLoop.runtimeMode,
              agentLoopPath: agentLoop.agentLoopPath,
            },
            updatedAt: new Date(),
            lastTurnAt: new Date(),
          },
          $unset: { _streamingInterrupted: '' },
        }
      )
      // Refresh TTL for all files associated with this session (both collections)
      const ttlRefresh = { $set: { expiresAt: new Date(Date.now() + REFERENCED_TTL_MS) } }
      await Promise.all([
        db.aiFiles.updateMany(
          { sessionId: session._id },
          ttlRefresh
        ).catch(err => logger.warn({ err }, 'Failed to refresh aiFiles TTL')),
        db.aiAttachments.updateMany(
          { sessionId: session._id },
          ttlRefresh
        ).catch(err => logger.warn({ err }, 'Failed to refresh aiAttachments TTL')),
      ])
    } else if (session._streamingContext?.length > 0) {
      // For resume, pre-load existing tool context from _streamingContext
      pushToolContext(toolContextMessages, session._streamingContext)
      await db.aiSessions.updateOne(
        { _id: session._id },
        {
          $set: {
            activeTurn: {
              id: messageId,
              status: 'running',
              startedAt: new Date(),
              resumed: true,
              runtimeMode: agentLoop.runtimeMode,
              agentLoopPath: agentLoop.agentLoopPath,
            },
            updatedAt: new Date(),
          },
        }
      )
    }

    // Load persisted readDocuments into context
    const initialReadDocuments = new Map()
    if (session._readDocuments) {
      for (const [key, value] of Object.entries(session._readDocuments)) {
        initialReadDocuments.set(key, value)
      }
    }
    const enrichedRunContext = {
      ...(context || {}),
      _initialReadDocuments: initialReadDocuments,
      _fileStoreAdapter: fileStoreAdapter,
      _modelCapabilities: modelCapabilities,
      _userId: userId,
      _persistentWorkspace: persistentWorkspace,
    }

    // Inject pre-loaded files into context
    if (loadedFiles.length > 0) {
      enrichedRunContext._attachments = loadedFiles
    }

    const generator = options.resume
      ? agentLoop.resume(enrichedRunContext)
      : agentLoop.run(content, enrichedRunContext)

    for await (const event of generator) {
      // Wall time budget check
      if (runBudget && runBudget.isWallTimeExceeded()) {
        logger.warn({ sessionId, elapsed: runBudget.getElapsedWallTimeMs() }, 'RunBudget: wall time exceeded')
        agentLoop.stop()
        const wallTimeText = '\n\n[已达到最大运行时间限制，对话已停止。]'
        fullContent += wallTimeText
        // Also update contentBlocks
        const lastBlock = contentBlocks[contentBlocks.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.content += wallTimeText
        } else {
          contentBlocks.push({ type: 'text', content: wallTimeText })
        }
        sendEvent({ type: 'text_chunk', content: wallTimeText, messageId })
        // Send a conversation_stopped event so the frontend transitions out of streaming state
        sendEvent({
          type: 'conversation_stopped',
          message: {
            id: messageId,
            role: 'assistant',
            content: fullContent,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
            timestamp: Date.now(),
            interrupted: true,
            modelInfo: modelInfoSnapshot || undefined,
          },
          usage: null,
          runBudgetSummary: {
            llmCalls: runBudget.llmCalls,
            toolCalls: runBudget.toolCalls,
            delegations: runBudget.delegations,
            totalTokens: runBudget.totalTokens,
            wallTimeMs: runBudget.getElapsedWallTimeMs(),
          },
        })
        break
      }

      const eventSessionId = event.sessionId || sessionId

      // Transform events to match frontend expected format
      if (event.type === 'thinking') {
        const lastBlock = contentBlocks[contentBlocks.length - 1]
        if (lastBlock && lastBlock.type === 'thinking') {
          lastBlock.content += event.content
        } else {
          contentBlocks.push({ type: 'thinking', content: event.content })
        }
        sendEvent({
          type: 'thinking_chunk',
          content: event.content,
          messageId,
          sessionId: eventSessionId,
        })
      } else if (event.type === 'text') {
        // Guard: stop agent loop if accumulated content exceeds safe limit
        if (fullContent.length + event.content.length > MAX_MESSAGE_CHARS) {
          logger.warn(
            { sessionId, fullContentLength: fullContent.length, chunkLength: event.content.length, limit: MAX_MESSAGE_CHARS },
            'Streaming content limit exceeded, stopping agent loop'
          )
          agentLoop.stop()
          const limitText = '\n\n[已达到消息内容长度上限，对话已停止。]'
          fullContent += limitText
          const lastBlock = contentBlocks[contentBlocks.length - 1]
          if (lastBlock && lastBlock.type === 'text') {
            lastBlock.content += limitText
          } else {
            contentBlocks.push({ type: 'text', content: limitText })
          }
          sendEvent({ type: 'text_chunk', content: limitText, messageId })
          sendEvent({
            type: 'conversation_stopped',
            message: {
              id: messageId,
              role: 'assistant',
              content: fullContent,
              contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
              timestamp: Date.now(),
              interrupted: true,
              modelInfo: modelInfoSnapshot || undefined,
            },
            usage: null,
            runBudgetSummary: {
              llmCalls: runBudget.llmCalls,
              toolCalls: runBudget.toolCalls,
              delegations: runBudget.delegations,
              totalTokens: runBudget.totalTokens,
              wallTimeMs: runBudget.getElapsedWallTimeMs(),
            },
          })
          break
        }
        fullContent += event.content
        currentTurnAssistantContent += event.content
        // Maintain contentBlocks for interleaved rendering
        const lastBlock = contentBlocks[contentBlocks.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          lastBlock.content += event.content
        } else {
          contentBlocks.push({ type: 'text', content: event.content })
        }
        sendEvent({
          type: 'text_chunk',
          content: event.content,
          messageId,
          sessionId: eventSessionId,
        })
      } else if (event.type === 'tool_call') {
        currentTurnToolCalls.push(event.toolCall)
        await agentMessageStore.startToolCall({
          sessionId: session._id,
          messageId,
          toolCall: event.toolCall,
          queued: event.queued || false,
        })
        // Collect tool call entry for persistence
        let parsedArgs = {}
        try {
          parsedArgs = JSON.parse(event.toolCall.function?.arguments || '{}')
        } catch {
          // ignore parse errors
        }
        const tcEntry = {
          id: event.toolCall.id,
          tool: event.toolCall.function?.name || 'unknown',
          arguments: parsedArgs,
          status: event.queued ? 'queued' : 'running',
        }
        contentBlocks.push({ type: 'tool_call', entry: { ...tcEntry } })
        toolCallBlockMap.set(tcEntry.id, contentBlocks[contentBlocks.length - 1])
        sendEvent({
          type: 'tool_call',
          toolCall: event.toolCall,
          messageId,
          sessionId: eventSessionId,
          queued: event.queued || false,
        })
      } else if (event.type === 'tool_call_start') {
        await agentMessageStore.markToolCallRunning({
          sessionId: session._id,
          toolCallId: event.toolCallId,
        })
        const tcBlock = toolCallBlockMap.get(event.toolCallId)
        if (tcBlock) tcBlock.entry.status = 'running'
        sendEvent({
          type: 'tool_call_start',
          toolCallId: event.toolCallId,
          messageId,
          sessionId: eventSessionId,
        })
      } else if (event.type === 'agent_team.started') {
        sendEvent({
          type: 'agent_team.started',
          teamId: event.teamId,
          workflowType: event.workflowType,
          mode: event.mode,
          status: event.status,
          messageId,
          sessionId: event.sessionId || eventSessionId,
        })
      } else if (event.type === 'tool_result') {
        await agentMessageStore.finishToolCall({
          sessionId: session._id,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
        })
        // Collect tool result for streaming context
        currentTurnToolResults.push({
          toolCallId: event.toolCallId,
          content: event.result.output || JSON.stringify(event.result),
        })

        // Update contentBlocks tool_call entry
        const tcBlock = toolCallBlockMap.get(event.toolCallId)
        if (tcBlock) {
          tcBlock.entry.status = event.result.success ? 'completed' : 'error'
          tcBlock.entry.result = {
            data: event.result.data,
            error: event.result.error,
          }
        }
        sendEvent({
          type: 'tool_result',
          toolResult: {
            ...event.result,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          },
          messageId,
          sessionId: eventSessionId,
        })

        // Check if a complete main-session tool call cycle is done
        if (currentTurnToolCalls.length > 0 && currentTurnToolResults.length === currentTurnToolCalls.length) {
          const contextMessages = []
          contextMessages.push({
            role: 'assistant',
            content: currentTurnAssistantContent || null,
            tool_calls: currentTurnToolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.function?.name, arguments: tc.function?.arguments },
            })),
          })
          for (const tr of currentTurnToolResults) {
            contextMessages.push({
              role: 'tool',
              tool_call_id: tr.toolCallId,
              content: tr.content,
            })
          }
          await db.aiSessions.updateOne(
            { _id: session._id },
            {
              $push: {
                _streamingContext: {
                  $each: contextMessages,
                  $slice: -STREAMING_CONTEXT_MAX_ITEMS,
                },
              },
              $set: { updatedAt: new Date() },
            }
          )
          // Also collect for toolContext persistence
          pushToolContext(toolContextMessages, contextMessages)
          // Reset current turn
          currentTurnAssistantContent = ''
          currentTurnToolCalls = []
          currentTurnToolResults = []
        }
      } else if (event.type === 'draft_change.created') {
        sendEvent({
          ...event,
          messageId,
          sessionId: eventSessionId,
        })
      } else if (
        event.type === 'canonical_change.applying' ||
        event.type === 'canonical_change.applied' ||
        event.type === 'draft_change.accepted' ||
        event.type === 'draft_change.conflict'
      ) {
        sendEvent({
          ...event,
          messageId,
          sessionId: eventSessionId,
        })
      } else if (
        event.type === 'command.started' ||
        event.type === 'command.output' ||
        event.type === 'command.completed' ||
        event.type === 'command.failed' ||
        event.type === 'security.command_blocked' ||
        event.type === 'workspace.file_written' ||
        event.type === 'skill.activated' ||
        event.type === 'skill.reference.loaded' ||
        event.type === 'skill.script.started' ||
        event.type === 'skill.script.completed'
      ) {
        sendEvent({
          ...event,
          messageId,
          sessionId: eventSessionId,
        })
      } else if (event.type === 'awaiting_confirmation') {
        // Synchronous confirmation: send change to frontend for user review
        sendEvent({
          type: 'awaiting_confirmation',
          change: event.change,
          messageId,
          sessionId: eventSessionId,
        })
        // Record in main session's changeHistory (even if from child)
        await db.aiSessions.updateOne(
          { _id: session._id },
          {
            $push: {
              changeHistory: {
                $each: [{ ...event.change, status: 'awaiting' }],
                $slice: -CHANGE_HISTORY_MAX_ITEMS,
              },
            },
          }
        )
      } else if (event.type === 'change_conflict') {
        sendEvent({
          type: 'change_conflict',
          changeId: event.changeId,
          conflictType: event.conflictType || 'UNKNOWN',
          message: event.message,
          messageId,
          sessionId: eventSessionId,
        })
        await db.aiSessions.updateOne(
          { _id: session._id, 'changeHistory.id': event.changeId },
          {
            $set: {
              'changeHistory.$.status': 'conflict',
              'changeHistory.$.conflictType': event.conflictType || 'UNKNOWN',
            },
          }
        )
      } else if (event.type === 'change_confirmed') {
        // Confirmation resolved: notify frontend
        sendEvent({
          type: 'change_confirmed',
          changeId: event.changeId,
          action: event.action,
          messageId,
          sessionId: eventSessionId,
        })
        // Update change status in main session's changeHistory
        await db.aiSessions.updateOne(
          { _id: session._id, 'changeHistory.id': event.changeId, 'changeHistory.$.status': { $ne: 'conflict' } },
          { $set: { 'changeHistory.$.status': event.action === 'accept' ? 'accepted' : 'rejected' } }
        )
      } else if (event.type === 'done') {
        if (event.readDocuments) {
          finalReadDocuments = event.readDocuments
        }
        const compactionConfig = settings.compaction || {}
        sendEvent({
          type: 'message_complete',
          message: {
            id: messageId,
            role: 'assistant',
            content: fullContent,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
            timestamp: Date.now(),
            modelInfo: modelInfoSnapshot || undefined,
          },
          usage: event.usage || null,
          runBudgetSummary: event.runBudgetSummary || null,
          compaction: {
            contextWindow: compactionConfig.contextWindow || 131072,
            threshold: compactionConfig.threshold || 0.7,
          },
        })
      } else if (event.type === 'stopped') {
        if (event.readDocuments) {
          finalReadDocuments = event.readDocuments
        }
        sendEvent({
          type: 'conversation_stopped',
          message: {
            id: messageId,
            role: 'assistant',
            content: fullContent,
            contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
            timestamp: Date.now(),
            interrupted: true,
            modelInfo: modelInfoSnapshot || undefined,
          },
          usage: event.usage || null,
          runBudgetSummary: event.runBudgetSummary || null,
        })
      } else if (event.type === 'compaction_start') {
        sendEvent({ type: 'compaction_start', messageId })
      } else if (event.type === 'compaction_done') {
        sendEvent({ type: 'compaction_done', success: event.success, messageId })
      } else if (event.type === 'context_truncated') {
        sendEvent({ type: 'context_truncated', messageId })
      } else if (event.type === 'error') {
        sendEvent({
          type: 'error',
          error: {
            message: event.error,
            code: event.code,
          },
          sessionId: eventSessionId,
        })
      }
    }

    // Send final stream_end event
    sendEvent({ type: 'done' })

    // Save final assistant message + clear _streamingContext (transactional)
    const assistantSeq = await allocateSeq(session._id, 1)
    const assistantDoc = {
      sessionId: session._id,
      seq: assistantSeq,
      role: 'assistant',
      content: fullContent,
      contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
      toolContext: toolContextMessages.length > 0 ? toolContextMessages : undefined,
      interrupted: (streamInterrupted || agentLoop.stopRequested) ? true : undefined,
      modelInfo: modelInfoSnapshot || undefined,
      timestamp: new Date(),
    }
    const txnSession = mongoClient.startSession()
    try {
      await txnSession.withTransaction(async () => {
        await db.aiMessages.insertOne(assistantDoc, { session: txnSession })
        const latestTurnSession = await db.aiSessions.findOne(
          { _id: session._id },
          {
            projection: { activeTurn: 1 },
            session: txnSession,
          }
        )
        const currentTurn = latestTurnSession?.activeTurn || {}
        const currentTurnStatus = currentTurn.status || null
        const preserveStoppedTurn = currentTurnStatus === 'stopped'
        const preserveInterruptedTurn =
          currentTurnStatus === 'interrupted' && currentTurn.reason !== 'client_disconnected'
        // When stream was interrupted (client disconnect OR server-side disconnect
        // like SSE queue limit, backpressure, drain timeout, or res error),
        // preserve _streamingContext and mark as interrupted so resume can
        // detect the interruption and continue from where it left off.
        if (streamInterrupted) {
          logger.info(
            { sessionId, disconnectedByClient },
            'Stream interrupted, preserving _streamingContext for resume'
          )
          await db.aiSessions.updateOne(
            { _id: session._id },
            {
              $set: {
                updatedAt: new Date(),
                lastTurnAt: new Date(),
                ...(preserveStoppedTurn
                  ? {}
                  : {
                      _streamingInterrupted: true,
                      ...(preserveInterruptedTurn
                        ? {}
                        : {
                            'activeTurn.status': 'interrupted',
                            'activeTurn.reason': disconnectedByClient ? 'client_disconnected' : 'stream_interrupted',
                            'activeTurn.interruptedAt': new Date(),
                          }),
                    }),
                ...(finalReadDocuments && finalReadDocuments.size > 0 && {
                  _readDocuments: Object.fromEntries(finalReadDocuments),
                }),
              },
              ...(preserveStoppedTurn ? { $unset: { _streamingContext: '', _streamingInterrupted: '' } } : {}),
            },
            { session: txnSession }
          )
        } else {
          const completedTurnPatch = agentLoop.stopRequested
            ? (
                preserveInterruptedTurn
                  ? {}
                  : {
                      'activeTurn.status': 'stopped',
                      'activeTurn.reason': 'user_stop',
                      'activeTurn.stoppedAt': new Date(),
                    }
              )
            : { 'activeTurn.status': 'completed', 'activeTurn.completedAt': new Date() }
          await db.aiSessions.updateOne(
            { _id: session._id },
            {
              $unset: { _streamingContext: '', _streamingInterrupted: '' },
              $set: {
                updatedAt: new Date(),
                lastTurnAt: new Date(),
                ...completedTurnPatch,
                ...(finalReadDocuments && finalReadDocuments.size > 0 && {
                  _readDocuments: Object.fromEntries(finalReadDocuments),
                }),
              },
            },
            { session: txnSession }
          )
        }
      })
    } finally {
      await txnSession.endSession()
    }
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Streaming error')
    await agentMessageStore.markTurnFailed({ sessionId: session._id, error })
    const safeMessage = (error.status && error.status < 500)
      ? error.message
      : 'Internal error'
    sendEvent({
      type: 'error',
      error: {
        message: safeMessage,
        code: error.code || 'STREAMING_ERROR',
      },
    })
  } finally {
    clearInterval(heartbeatTimer)
    confirmationChannel.abort()
    activeChannels.delete(sessionId)
    activeAgentLoops.delete(sessionId)
    // Clean up per-user session tracking
    if (userId && !session.parentId) {
      const userSessions = activeRootSessionsByUser.get(userId)
      if (userSessions) {
        userSessions.delete(sessionId)
        if (userSessions.size === 0) {
          activeRootSessionsByUser.delete(userId)
        }
      }
    }
    if (connectionAlive) res.end()
  }
}

/**
 * Stop an active agent loop for a session
 */
async function stopSession(req, res) {
  const { sessionId } = req.params

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  const stoppedSessionIds = await stopActiveSessionTree(session)
  if (!stoppedSessionIds.length) {
    await markSessionStopped(session._id)
    return res.json({ success: true, message: 'No active agent loop' })
  }
  await markSessionStopped(session._id)
  logger.info({ sessionId }, 'Stop requested for agent loop')
  res.json({ success: true })
}

async function stopActiveSessionTree(session) {
  const childSessions = await db.aiSessions
    .find(
      { rootSessionId: session._id, _id: { $ne: session._id } },
      { projection: { _id: 1 } }
    )
    .toArray()
  const sessionIds = [session._id, ...childSessions.map(item => item._id)]
  const stoppedSessionIds = await stopActiveSessionsById(sessionIds)
  if (stoppedSessionIds.length) {
    await markSessionStopped(session._id)
  }
  return stoppedSessionIds
}

async function stopActiveSessionsById(sessionObjectIds = []) {
  const stoppedSessionIds = []
  for (const sessionObjectId of sessionObjectIds) {
    const sessionId = sessionObjectId.toString()
    const activeLoop = activeAgentLoops.get(sessionId)
    if (activeLoop) {
      try { activeLoop.stop() } catch {}
      activeAgentLoops.delete(sessionId)
      stoppedSessionIds.push(sessionId)
    }
    const channel = activeChannels.get(sessionId)
    if (channel) {
      try { channel.abort() } catch {}
      activeChannels.delete(sessionId)
    }
  }
  return stoppedSessionIds
}

async function markSessionStopped(sessionObjectId) {
  await db.aiSessions.updateOne(
    { _id: sessionObjectId },
    {
      $set: {
        'activeTurn.status': 'stopped',
        'activeTurn.reason': 'user_stop',
        'activeTurn.stoppedAt': new Date(),
        updatedAt: new Date(),
      },
      $unset: { _streamingInterrupted: '' },
    }
  )
}

/**
 * Confirm or reject a change during synchronous edit flow.
 * Called by the frontend while the SSE stream is open and the AgentLoop is waiting.
 */
async function confirmChange(req, res) {
  const { sessionId, changeId } = req.params
  const { action, reason } = req.body

  if (!action || !['accept', 'reject'].includes(action)) {
    throw new ValidationError('action must be "accept" or "reject"')
  }

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  // Re-check project write access (user may have been removed or downgraded to read-only)
  const confirmUserId = req.headers['x-user-id']
  const hasConfirmAccess = await _checkProjectWriteAccess(session.projectId, confirmUserId)
  if (!hasConfirmAccess) {
    return res.status(403).json({ error: 'Write access to project denied' })
  }

  const channel = activeChannels.get(sessionId)
  if (!channel) {
    // No active channel — agent loop may not be running
    // Check if the change exists in session's pending changes for better feedback
    const change = session.changeHistory?.find(c => c.id === changeId)
    if (!change) {
      return res.status(404).json({ error: 'Change not found' })
    }
    if (change.status && change.status !== 'awaiting') {
      return res.status(409).json({ error: `Change already ${change.status}` })
    }
    return res.status(409).json({ error: 'Agent loop not active, cannot confirm' })
  }

  const found = channel.confirm(changeId, action, reason)
  if (!found) {
    return res.status(404).json({ error: 'No pending confirmation for this change' })
  }

  res.json({ success: true })
}

/**
 * Accept a pending change (deprecated — use confirmChange instead)
 */
async function acceptChange(req, res) {
  const { sessionId, changeId } = req.params

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  // Check project write access (accepting a change triggers document writes)
  const acceptUserId = req.headers['x-user-id']
  const hasWriteAccess = await _checkProjectWriteAccess(session.projectId, acceptUserId)
  if (!hasWriteAccess) {
    return res.status(403).json({ error: 'Write access to project denied' })
  }

  const change = session.pendingChanges?.find(c => c.id === changeId)

  if (!change) {
    throw new ChangeNotFoundError(changeId)
  }

  // Validate change is still pending
  if (change.status !== 'pending') {
    throw new ValidationError(`Change is already ${change.status}`)
  }

  // Atomic lock: claim this change before executing the apply operation.
  // This prevents concurrent requests from applying the same change twice.
  // Also allow acquiring expired locks to prevent deadlocks from crashed processes.
  const LOCK_TTL_MS = settings.aiAssistant?.changeLockTtlMs || 2 * 60 * 1000 // 2-minute lock timeout
  const lockExpiry = new Date(Date.now() - LOCK_TTL_MS)

  const lockResult = await db.aiSessions.updateOne(
    {
      _id: session._id,
      pendingChanges: {
        $elemMatch: {
          id: changeId,
          status: 'pending',
          $or: [
            { _applyLock: { $exists: false } },
            { _applyLockAt: { $lt: lockExpiry } },
          ],
        },
      },
    },
    {
      $set: {
        'pendingChanges.$._applyLock': true,
        'pendingChanges.$._applyLockAt': new Date(),
        updatedAt: new Date(),
      },
    }
  )
  if (lockResult.modifiedCount === 0) {
    return res.status(409).json({ error: 'Change is already being processed' })
  }

  const effectiveUserId = req.headers['x-user-id'] || session.userId || 'ai-agent'

  const changeType = change.type || 'edit'

  try {
    let result

    switch (changeType) {
      case 'edit':
        // Existing logic: apply edit via Document-Updater
        result = await documentAdapter.applyEdit(change, {
          userId: effectiveUserId,
        })
        break

      case 'create':
        result = await handleCreateChange(change, effectiveUserId)
        break

      case 'delete':
        result = await handleDeleteChange(change, effectiveUserId)
        break

      default:
        throw new ValidationError(`Unknown change type: ${changeType}`)
    }

    // Mark change as accepted and release lock
    const acceptResult = await db.aiSessions.updateOne(
      {
        _id: session._id,
        pendingChanges: { $elemMatch: { id: changeId } },
      },
      {
        $set: {
          'pendingChanges.$.status': 'accepted',
          'pendingChanges.$.acceptedAt': new Date(),
          'pendingChanges.$.appliedVersion': result.newVersion,
          'pendingChanges.$.wasRebased': result.wasRebased,
          updatedAt: new Date(),
        },
        $unset: {
          'pendingChanges.$._applyLock': '',
          'pendingChanges.$._applyLockAt': '',
        },
      }
    )

    if (acceptResult.modifiedCount === 0) {
      return res.status(409).json({
        success: false,
        error: 'CONFLICT',
        message: 'Change is no longer in pending status (may have been accepted or rejected by another request)',
      })
    }
    await syncDraftBackedChangeStatus(change, session, 'accepted', {
      appliedVersion: result.newVersion,
      wasRebased: result.wasRebased,
    })

    logger.info(
      { sessionId, changeId, wasRebased: result.wasRebased },
      'Change accepted and applied'
    )

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
    // Handle rebase/version conflicts
    if (
      error instanceof DocRebaseConflictError ||
      error instanceof VersionConflictError ||
      error instanceof EditMatchError
    ) {
      // Mark change as conflict in database and release lock
      await db.aiSessions.updateOne(
        { _id: session._id, 'pendingChanges.id': changeId },
        {
          $set: {
            'pendingChanges.$.status': 'conflict',
            'pendingChanges.$.conflictAt': new Date(),
            'pendingChanges.$.conflictType': error.info?.conflictType || 'UNKNOWN',
            'pendingChanges.$.conflictMessage': error.message,
            updatedAt: new Date(),
          },
          $unset: {
            'pendingChanges.$._applyLock': '',
            'pendingChanges.$._applyLockAt': '',
          },
        }
      )
      await syncDraftBackedChangeStatus(change, session, 'conflict', {
        conflictType: error.info?.conflictType || 'UNKNOWN',
        conflictMessage: error.message,
      })

      logger.warn(
        { sessionId, changeId, conflictType: error.info?.conflictType, err: error },
        'Change conflict detected'
      )

      return res.status(409).json({
        success: false,
        error: 'REBASE_CONFLICT',
        message: error.message,
        conflictType: error.info?.conflictType,
        change: {
          ...change,
          status: 'conflict',
          conflictType: error.info?.conflictType || 'UNKNOWN',
          conflictMessage: error.message,
          stale: true,
        },
        suggestion: 'Please regenerate the edit based on current document content',
      })
    }

    // Release lock on unexpected errors
    await db.aiSessions.updateOne(
      { _id: session._id, 'pendingChanges.id': changeId },
      {
        $unset: {
          'pendingChanges.$._applyLock': '',
          'pendingChanges.$._applyLockAt': '',
        },
      }
    ).catch(unlockErr => {
      logger.warn({ sessionId, changeId, err: unlockErr }, 'Failed to release _applyLock after error')
    })

    throw error
  }
}

/**
 * Reject a pending change
 */
async function rejectChange(req, res) {
  const { sessionId, changeId } = req.params
  const { reason } = req.body

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  const change = session.pendingChanges?.find(c => c.id === changeId)

  if (!change) {
    throw new ChangeNotFoundError(changeId)
  }

  // Allow rejecting pending or conflict status
  if (change.status !== 'pending' && change.status !== 'conflict') {
    throw new ValidationError(`Cannot reject change with status: ${change.status}`)
  }

  // Mark change as rejected (atomically verify status is still pending or conflict)
  const updateFields = {
    'pendingChanges.$.status': 'rejected',
    'pendingChanges.$.rejectedAt': new Date(),
    updatedAt: new Date(),
  }

  if (reason) {
    updateFields['pendingChanges.$.rejectReason'] = reason
  }

  const rejectResult = await db.aiSessions.updateOne(
    {
      _id: session._id,
      pendingChanges: { $elemMatch: { id: changeId, status: { $in: ['pending', 'conflict'] } } },
    },
    { $set: updateFields }
  )

  if (rejectResult.modifiedCount === 0) {
    return res.status(409).json({
      success: false,
      error: 'CONFLICT',
      message: 'Change is no longer in a rejectable status (may have been accepted or rejected by another request)',
    })
  }
  await syncDraftBackedChangeStatus(change, session, 'rejected', {
    rejectReason: reason,
  })

  logger.info({ sessionId, changeId, reason }, 'Change rejected')

  res.json({
    success: true,
    change: {
      ...change,
      status: 'rejected',
      rejectReason: reason,
    },
  })
}

/**
 * Accept all pending changes
 */
async function acceptAllChanges(req, res) {
  const { sessionId } = req.params

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  // Re-check project write access (user may have been removed or downgraded to read-only)
  const userId = req.headers['x-user-id']
  const hasAccess = await _checkProjectWriteAccess(session.projectId, userId)
  if (!hasAccess) {
    return res.status(403).json({ error: 'Write access to project denied' })
  }

  const pendingChanges = session.pendingChanges?.filter(
    c => c.status === 'pending'
  ) || []

  if (pendingChanges.length === 0) {
    return res.json({ success: true, changes: [] })
  }

  const effectiveUserId = req.headers['x-user-id'] || session.userId || 'ai-agent'
  const results = []

  const LOCK_TTL_MS = settings.aiAssistant?.changeLockTtlMs || 2 * 60 * 1000 // 2-minute lock timeout

  // Apply each change sequentially to preserve order
  for (const change of pendingChanges) {
    // Atomic lock: claim this change before executing the apply operation.
    // This prevents concurrent requests from applying the same change twice.
    const lockExpiry = new Date(Date.now() - LOCK_TTL_MS)
    const lockResult = await db.aiSessions.updateOne(
      {
        _id: session._id,
        pendingChanges: {
          $elemMatch: {
            id: change.id,
            status: 'pending',
            $or: [
              { _applyLock: { $exists: false } },
              { _applyLockAt: { $lt: lockExpiry } },
            ],
          },
        },
      },
      {
        $set: {
          'pendingChanges.$._applyLock': true,
          'pendingChanges.$._applyLockAt': new Date(),
          updatedAt: new Date(),
        },
      }
    )
    if (lockResult.modifiedCount === 0) {
      // This change is already being processed by another request, skip
      continue
    }

    try {
      const changeType = change.type || 'edit'
      let result

      switch (changeType) {
        case 'edit':
          result = await documentAdapter.applyEdit(change, {
            userId: effectiveUserId,
          })
          break
        case 'create':
          result = await handleCreateChange(change, effectiveUserId)
          break
        case 'delete':
          result = await handleDeleteChange(change, effectiveUserId)
          break
        default:
          throw new ValidationError(`Unknown change type: ${changeType}`)
      }

      // Mark change as accepted and release lock
      await db.aiSessions.updateOne(
        { _id: session._id, 'pendingChanges.id': change.id },
        {
          $set: {
            'pendingChanges.$.status': 'accepted',
            'pendingChanges.$.acceptedAt': new Date(),
            'pendingChanges.$.appliedVersion': result.newVersion,
            'pendingChanges.$.wasRebased': result.wasRebased,
            updatedAt: new Date(),
          },
          $unset: {
            'pendingChanges.$._applyLock': '',
            'pendingChanges.$._applyLockAt': '',
          },
        }
      )

      results.push({
        ...change,
        status: 'accepted',
        appliedVersion: result.newVersion,
        wasRebased: result.wasRebased,
      })
    } catch (error) {
      // Mark this change as conflict and release lock, continue with remaining changes
      const conflictType = error.info?.conflictType || 'UNKNOWN'
      await db.aiSessions.updateOne(
        { _id: session._id, 'pendingChanges.id': change.id },
        {
          $set: {
            'pendingChanges.$.status': 'conflict',
            'pendingChanges.$.conflictAt': new Date(),
            'pendingChanges.$.conflictType': conflictType,
            'pendingChanges.$.conflictMessage': error.message,
            updatedAt: new Date(),
          },
          $unset: {
            'pendingChanges.$._applyLock': '',
            'pendingChanges.$._applyLockAt': '',
          },
        }
      )

      logger.warn(
        { sessionId, changeId: change.id, conflictType, err: error },
        'Change conflict in acceptAll'
      )

      results.push({
        ...change,
        status: 'conflict',
        conflictType,
        conflictMessage: error.message,
      })
    }
  }

  const accepted = results.filter(c => c.status === 'accepted')
  const conflicts = results.filter(c => c.status === 'conflict')

  logger.info(
    { sessionId, accepted: accepted.length, conflicts: conflicts.length },
    'Batch accept completed'
  )

  res.json({
    success: conflicts.length === 0,
    changes: results,
    summary: {
      total: results.length,
      accepted: accepted.length,
      conflicts: conflicts.length,
    },
  })
}

/**
 * Reject all pending changes
 */
async function rejectAllChanges(req, res) {
  const { sessionId } = req.params

  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  const pendingChanges = session.pendingChanges?.filter(
    c => c.status === 'pending'
  ) || []

  if (pendingChanges.length === 0) {
    return res.json({ success: true, changes: [] })
  }

  await db.aiSessions.updateOne(
    { _id: session._id },
    {
      $set: {
        'pendingChanges.$[elem].status': 'rejected',
        'pendingChanges.$[elem].rejectedAt': new Date(),
        updatedAt: new Date(),
      },
    },
    {
      arrayFilters: [{ 'elem.status': 'pending' }],
    }
  )

  logger.info({ sessionId, count: pendingChanges.length }, 'All changes rejected')

  res.json({
    success: true,
    changes: pendingChanges.map(c => ({ ...c, status: 'rejected' })),
  })
}

/**
 * Handle a 'create' type pending change
 * Creates the file and writes content
 */
async function handleCreateChange(change, userId) {
  const { projectId, path: filePath, content } = change

  // Parse path into directory and filename
  const dirPath = path.dirname(filePath)
  const fileName = path.basename(filePath)

  // Ensure parent directory exists
  let parentFolderId = null
  if (dirPath && dirPath !== '/' && dirPath !== '.') {
    const folderResult = await projectAdapter.ensureFolderPath(projectId, dirPath, userId)
    parentFolderId = folderResult.folderId
  }

  // Create the document
  const doc = await projectAdapter.createDoc(projectId, fileName, parentFolderId, userId)

  // Write content if provided
  if (content) {
    try {
      const lines = content.split('\n')
      await documentAdapter._callSetDocAPI(projectId, doc._id, lines, userId, 0)
    } catch (writeErr) {
      // Rollback: attempt to delete the already-created doc (ignore deletion failure)
      try {
        await projectAdapter.deleteEntity(projectId, doc._id, 'doc', userId)
      } catch {}
      throw writeErr
    }
  }

  // Clear entity cache since file list has changed
  projectAdapter.clearCache(projectId)

  return { success: true, newVersion: 1, wasRebased: false }
}

/**
 * Handle a 'delete' type pending change
 * Deletes the entity from the project
 */
async function handleDeleteChange(change, userId) {
  const { projectId, entityId, entityType } = change

  await projectAdapter.deleteEntity(projectId, entityId, entityType, userId)

  // Clear entity cache since file list has changed
  projectAdapter.clearCache(projectId)

  return { success: true, newVersion: 0, wasRebased: false }
}

/**
 * Manually trigger context compaction for a session
 */
async function compactSession(req, res) {
  const session = await _loadAndAuthorizeSession(req, res)
  if (!session) return

  const compactionConfig = settings.compaction || {}
  if (!compactionConfig.enabled) {
    throw new ValidationError('Compaction is disabled')
  }

  // Resolve LLM adapter for compaction from DB default slot
  let compactionAdapter
  try {
    const sysConfig = await getModelConfigService().getSystemConfig()
    if (sysConfig?.defaultSlot) {
      const resolved = await getModelConfigService().resolveSlot(sysConfig.defaultSlot)
      compactionAdapter = resolved.adapter
    }
  } catch { /* ignore */ }
  if (!compactionAdapter) {
    throw new ValidationError('No model configuration found for compaction. Admin must configure models first.')
  }

  const result = await contextManager.compactHistory(
    session._id.toString(),
    compactionAdapter,
    compactionConfig,
    { proposeMemorySuggestions: true }
  )

  if (result.success) {
    res.json({ success: true, summary: result.summary })
  } else {
    res.status(400).json({ success: false, message: 'Compaction failed or not enough history' })
  }
}

/**
 * Search files in a project (for @ mention autocomplete)
 */
async function searchFiles(req, res) {
  const { projectId } = req.params
  const { query } = req.query

  const userId = req.headers['x-user-id']
  if (!await _checkProjectAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const files = await projectAdapter.listFiles(projectId, { type: 'all' })

  let results = files.map(f => ({
    path: f.path,
    type: f.type === 'doc' ? 'doc' : 'file',
  }))

  // Server-side filtering (client does fuzzy matching too)
  if (query) {
    const q = query.toLowerCase()
    results = results.filter(f => f.path.toLowerCase().includes(q))
  }

  // Limit results
  results = results.slice(0, 50)

  res.json({ files: results })
}

async function getAgentInstructions(req, res) {
  const { projectId } = req.params
  const userId = req.headers['x-user-id']
  const agentContext = getEnabledAgentContextConfig()

  if (!await _checkProjectAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const service = createProjectInstructionService(agentContext)
  const instructions = await service.getInstructions({ projectId })
  res.json({
    ...instructions,
    maxLength: agentContext.maxInstructionChars,
  })
}

async function createAgentInstructions(req, res) {
  const { projectId } = req.params
  const userId = req.headers['x-user-id']
  const { content = '' } = req.body || {}
  const agentContext = getEnabledAgentContextConfig()

  if (!await _checkProjectWriteAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Write access required to create project instructions' })
  }

  const service = createProjectInstructionService(agentContext)
  const instructions = await service.createInstructions({
    projectId,
    userId,
    content,
  })
  res.status(201).json({
    ...instructions,
    maxLength: agentContext.maxInstructionChars,
  })
}

async function saveAgentInstructionsDraft(req, res) {
  const { projectId } = req.params
  const userId = req.headers['x-user-id']
  const { sessionId, docId, baseVersion, content, mode } = req.body || {}
  const agentContext = getEnabledAgentContextConfig()

  if (!await _checkProjectWriteAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Write access required to update project instructions' })
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new ValidationError('sessionId is required')
  }

  const session = await findSession(sessionId)
  if (!session.userId || session.userId !== userId || session.projectId !== projectId) {
    return res.status(403).json({ error: 'Session does not belong to this project and user' })
  }

  const service = createProjectInstructionService(agentContext)
  const result = await service.saveDraft({
    sessionId,
    projectId,
    userId,
    docId,
    baseVersion,
    content,
    mode,
  })
  res.json(result)
}

async function listMemories(req, res) {
  const userId = req.headers['x-user-id']
  const { projectId, scope = 'all' } = req.query
  const agentContext = getEnabledAgentContextConfig()

  if (projectId && !await _checkProjectAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (!['global', 'project', 'all'].includes(scope)) {
    throw new ValidationError('Invalid memory scope')
  }

  const memories = await createMemoryService(agentContext).listMemories({
    userId,
    projectId: typeof projectId === 'string' ? projectId : null,
    scope,
    includeDisabled: req.query.includeDisabled === 'true',
  })
  res.json({
    memories: memories.map(serializeMemory),
    maxLength: agentContext.maxMemoryChars,
  })
}

async function createMemory(req, res) {
  const userId = req.headers['x-user-id']
  const { content, scope = 'global', projectId, tags } = req.body || {}
  const agentContext = getEnabledAgentContextConfig()

  if (scope === 'project') {
    if (!projectId) throw new ValidationError('projectId is required for project-scoped memory')
    if (!await _checkProjectWriteAccess(projectId, userId)) {
      return res.status(403).json({ error: 'Write access required to create project memory' })
    }
  }

  const memory = await createMemoryService(agentContext).createMemory({
    userId,
    projectId,
    scope,
    content,
    source: 'manual',
    tags,
  })
  res.status(201).json({ memory: serializeMemory(memory) })
}

async function updateMemory(req, res) {
  const userId = req.headers['x-user-id']
  const { memoryId } = req.params
  const agentContext = getEnabledAgentContextConfig()
  const memory = await createMemoryService(agentContext).updateMemory({
    memoryId: parseObjectId(memoryId, 'memoryId'),
    userId,
    content: req.body?.content,
    status: req.body?.status,
  })
  res.json({ memory: serializeMemory(memory) })
}

async function deleteMemory(req, res) {
  const userId = req.headers['x-user-id']
  const { memoryId } = req.params
  const agentContext = getEnabledAgentContextConfig()
  const memory = await createMemoryService(agentContext).deleteMemory({
    memoryId: parseObjectId(memoryId, 'memoryId'),
    userId,
  })
  res.json({ memory: serializeMemory(memory) })
}

async function listMemorySuggestions(req, res) {
  const userId = req.headers['x-user-id']
  const { projectId, status = 'pending' } = req.query
  const agentContext = getEnabledAgentContextConfig()

  if (projectId && !await _checkProjectAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const suggestions = await createMemorySuggestionService(agentContext)
    .listSuggestions({
      userId,
      projectId: typeof projectId === 'string' ? projectId : null,
      status,
    })
  res.json({ suggestions: suggestions.map(serializeMemorySuggestion) })
}

async function acceptMemorySuggestion(req, res) {
  const userId = req.headers['x-user-id']
  const { suggestionId } = req.params
  const agentContext = getEnabledAgentContextConfig()
  const result = await createMemorySuggestionService(agentContext)
    .acceptSuggestion({
      suggestionId: parseObjectId(suggestionId, 'suggestionId'),
      userId,
    })
  res.json({
    suggestion: serializeMemorySuggestion(result.suggestion),
    memory: serializeMemory(result.memory),
  })
}

async function dismissMemorySuggestion(req, res) {
  const userId = req.headers['x-user-id']
  const { suggestionId } = req.params
  const agentContext = getEnabledAgentContextConfig()
  const suggestion = await createMemorySuggestionService(agentContext)
    .dismissSuggestion({
      suggestionId: parseObjectId(suggestionId, 'suggestionId'),
      userId,
    })
  res.json({ suggestion: serializeMemorySuggestion(suggestion) })
}

async function getContextSnapshot(req, res) {
  const { sessionId, turnId } = req.params
  const userId = req.headers['x-user-id']
  getEnabledAgentContextConfig()
  const session = await findSession(sessionId, { allowTerminal: true })
  if (!session.userId || session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (!await _checkProjectAccess(session.projectId, userId)) {
    return res.status(403).json({ error: 'Access to project denied' })
  }
  const snapshot = await new ContextSnapshotService().findSnapshot({
    sessionId,
    userId,
    turnId,
  })
  res.json({ snapshot: serializeContextSnapshot(snapshot) })
}

async function getSessionSummary(req, res) {
  const { sessionId } = req.params
  const userId = req.headers['x-user-id']
  getEnabledAgentContextConfig()
  const session = await findSession(sessionId, { allowTerminal: true })
  if (!session.userId || session.userId !== userId) {
    return res.status(403).json({ error: 'Access denied' })
  }
  if (!await _checkProjectAccess(session.projectId, userId)) {
    return res.status(403).json({ error: 'Access to project denied' })
  }
  const summary = await new SessionSummaryService().findLatestSummary({
    sessionId,
    userId,
  })
  res.json({ summary: serializeSessionSummaryRecord(summary) })
}

/**
 * Get completion rules for a project
 */
async function getCompletionRules(req, res) {
  const { projectId } = req.params

  const userId = req.headers['x-user-id']
  if (!await _checkProjectAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Access denied' })
  }

  const doc = await db.aiCompletionRules.findOne(
    { projectId },
    { projection: { content: 1, updatedAt: 1 } }
  )
  const maxLen = settings.completionRules?.maxLength || 2000
  res.json({
    content: doc?.content || '',
    updatedAt: doc?.updatedAt || null,
    maxLength: maxLen,
  })
}

/**
 * Update completion rules for a project
 */
async function updateCompletionRules(req, res) {
  const { projectId } = req.params
  const { content } = req.body
  const userId = req.headers['x-user-id'] || null
  const maxLen = settings.completionRules?.maxLength || 2000

  if (!await _checkProjectWriteAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Write access required to update completion rules' })
  }

  if (typeof content !== 'string') {
    throw new ValidationError('content must be a string')
  }
  if (content.length > maxLen) {
    throw new ValidationError(`content exceeds maximum length of ${maxLen}`)
  }

  const now = new Date()
  await db.aiCompletionRules.updateOne(
    { projectId },
    {
      $set: { content, updatedBy: userId, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  )

  res.json({ success: true })
}

/**
 * Load and verify files by ID (checks aiFiles, falls back to aiAttachments for legacy data)
 * @param {string[]} fileIds - Array of file ID strings
 * @param {import('mongodb').ObjectId} sessionObjectId - Session ObjectId
 * @param {string} [userId] - User ID for ownership check
 * @returns {Promise<Array<{id: string, filename: string, mimeType: string, size: number, storageKey: string}>>}
 */
async function _loadVerifiedFiles(fileIds, sessionObjectId, userId) {
  if (!fileIds || fileIds.length === 0) return []

  const objectIds = []
  for (const id of fileIds) {
    try { objectIds.push(new ObjectId(id)) } catch {
      logger.warn({ fileId: id }, 'Invalid file ID, skipping')
    }
  }
  if (objectIds.length === 0) return []

  // Query aiFiles
  let files = await db.aiFiles
    .find({ _id: { $in: objectIds } })
    .toArray()

  // Fallback: query aiAttachments (legacy data)
  const foundIds = new Set(files.map(f => f._id.toString()))
  const missingIds = objectIds.filter(oid => !foundIds.has(oid.toString()))
  if (missingIds.length > 0) {
    const legacy = await db.aiAttachments
      .find({ _id: { $in: missingIds } })
      .toArray()
    files = files.concat(legacy)
  }

  // Ownership check: only allow files owned by this user.
  // When userId is absent, reject all files to prevent unauthorized access
  // (defence-in-depth: callers should always pass userId).
  if (userId) {
    files = files.filter(f => f.userId === userId)
  } else {
    logger.warn({ fileIds }, '_loadVerifiedFiles called without userId — rejecting all files')
    return []
  }

  // Bind to session + refresh TTL for unbound files
  if (sessionObjectId) {
    const unboundFiles = files.filter(f => !f.sessionId)
    // Separate by collection: aiFiles vs aiAttachments (legacy)
    const unboundFileIds = []
    const unboundAttachmentIds = []
    for (const f of unboundFiles) {
      if (foundIds.has(f._id.toString())) {
        unboundFileIds.push(f._id)
      } else {
        unboundAttachmentIds.push(f._id)
      }
    }
    const ttlUpdate = { $set: { sessionId: sessionObjectId, expiresAt: new Date(Date.now() + REFERENCED_TTL_MS) } }
    if (unboundFileIds.length > 0) {
      await db.aiFiles.updateMany({ _id: { $in: unboundFileIds } }, ttlUpdate)
    }
    if (unboundAttachmentIds.length > 0) {
      await db.aiAttachments.updateMany({ _id: { $in: unboundAttachmentIds } }, ttlUpdate)
    }
  }

  return files.map(f => ({
    id: f._id.toString(),
    filename: f.filename,
    mimeType: f.mimeType,
    size: f.size,
    storageKey: f.storageKey,
  }))
}

/**
 * Load a session and verify the requesting user owns it.
 * @returns {object|null} session document, or null if response was already sent
 */
async function _loadAndAuthorizeSession(req, res, options = {}) {
  const { sessionId } = req.params
  const userId = req.headers['x-user-id']
  const session = await findSession(sessionId, options)
  // Reject if session has no owner (legacy/corrupt data) or owner mismatch
  if (!session.userId || session.userId !== userId) {
    res.status(403).json({ error: 'Access denied' })
    return null
  }
  // Re-check project membership (user may have been removed from the project)
  const hasAccess = await _checkProjectAccess(session.projectId, userId)
  if (!hasAccess) {
    res.status(403).json({ error: 'Access to project denied' })
    return null
  }
  return session
}

/**
 * Helper to find and validate session
 */
async function findSession(sessionId, options = {}) {
  let objectId
  try {
    objectId = new ObjectId(sessionId)
  } catch {
    throw new ValidationError('Invalid session ID format')
  }

  const defaultProjection = { _streamingContext: 0, _readDocuments: 0, promptSnapshot: 0 }
  const projection = options.projection || defaultProjection

  const session = await db.aiSessions.findOne({ _id: objectId }, { projection })

  if (!session) {
    throw new SessionNotFoundError(sessionId)
  }

  if (!options.allowTerminal && isTerminalSessionStatus(session.status)) {
    throw new SessionExpiredError(sessionId)
  }

  return session
}

export default {
  initialize,
  shutdown,
  createSession: expressify(createSession),
  listSessions: expressify(listSessions),
  getSession: expressify(getSession),
  listTeamRuns: expressify(listTeamRuns),
  getTeamRun: expressify(getTeamRun),
  cancelTeamRun: expressify(cancelTeamRun),
  retryTeamRunTask: expressify(retryTeamRunTask),
  updateSession: expressify(updateSession),
  deleteSession: expressify(deleteSession),
  sendMessage: expressify(sendMessage),
  stopSession: expressify(stopSession),
  confirmChange: expressify(confirmChange),
  uploadAttachment: expressify(uploadAttachment),
  getAttachment: expressify(getAttachment),
  getSessionArtifact: expressify(getSessionArtifact),
  uploadFile: expressify(uploadFile),
  getFile: expressify(getFile),
  acceptChange: expressify(acceptChange),
  rejectChange: expressify(rejectChange),
  acceptAllChanges: expressify(acceptAllChanges),
  rejectAllChanges: expressify(rejectAllChanges),
  searchFiles: expressify(searchFiles),
  compactSession: expressify(compactSession),
  getAgentInstructions: expressify(getAgentInstructions),
  createAgentInstructions: expressify(createAgentInstructions),
  saveAgentInstructionsDraft: expressify(saveAgentInstructionsDraft),
  listMemories: expressify(listMemories),
  createMemory: expressify(createMemory),
  updateMemory: expressify(updateMemory),
  deleteMemory: expressify(deleteMemory),
  listMemorySuggestions: expressify(listMemorySuggestions),
  acceptMemorySuggestion: expressify(acceptMemorySuggestion),
  dismissMemorySuggestion: expressify(dismissMemorySuggestion),
  getContextSnapshot: expressify(getContextSnapshot),
  getSessionSummary: expressify(getSessionSummary),
  getCompletionRules: expressify(getCompletionRules),
  updateCompletionRules: expressify(updateCompletionRules),
  // Internal helpers (not Express routes)
  createChildSession,
  updateSessionStatus,
  reconcileInterruptedTurns,
}
