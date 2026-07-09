const DEFAULT_MAX_FILE_CHARS = 12000
const DEFAULT_TOKEN_BUDGET = 12000
const DEFAULT_MAX_MEMORY_CHARS = 1200
const DEFAULT_MAX_MEMORIES = 3
const DEFAULT_MAX_SUMMARY_CHARS = 2000
const DEFAULT_MAX_RECALL_CHARS = 2000
const SAFE_FILE_MODE = new Set(['full', 'excerpt', 'summary', 'metadata'])
const SAFE_MEMORY_SCOPE = new Set(['project', 'global'])
const SAFE_RECALL_TYPE = new Set(['memory', 'summary', 'session-summary', 'recall'])
const SENSITIVE_KEY_RE = /(?:prompt|hiddenPrompt|systemPrompt|apiKey|token|secret|password|credential)/i
const SECRET_VALUE_RE = /\b(?:apiKey|token|secret|password|credential)\s*=\s*[^\s,;]+/gi

export class AgentContextPackBuilder {
  async build(input = {}) {
    const contextPolicy = input.contextPolicy || {}
    const maxFileChars = normalizePositiveInteger(
      contextPolicy.maxFileChars,
      DEFAULT_MAX_FILE_CHARS
    )
    return {
      teamId: requireString(input.teamId, 'teamId'),
      taskId: requireString(input.taskId, 'taskId'),
      projectId: requireString(input.projectId, 'projectId'),
      sessionId: requireString(input.sessionId, 'sessionId'),
      activeChangeSetId: input.activeChangeSetId || null,
      userRequestSummary: redact(input.userRequest || input.userRequestSummary || ''),
      parentHistorySummary:
        contextPolicy.includeParentHistory === true
          ? redact(input.parentHistorySummary || '')
          : null,
      projectInstructions: normalizeProjectInstructions(
        input.projectInstructions,
        contextPolicy
      ),
      memories: normalizeMemories(input.memories, contextPolicy),
      sessionSummary: normalizeSessionSummary(input.sessionSummary, contextPolicy),
      recalledContext: normalizeRecalledContext(input.recalledContext, contextPolicy),
      files: normalizeFiles(input.files, maxFileChars),
      artifacts: sanitizeStructuredArray(input.artifacts),
      priorFindings: sanitizeStructuredArray(input.priorFindings),
      diagnostics:
        contextPolicy.includeDiagnostics === true
          ? sanitizeDiagnostics(input.diagnostics || {})
          : {},
      tokenBudget: normalizePositiveInteger(
        input.tokenBudget,
        DEFAULT_TOKEN_BUDGET
      ),
      sourceCounts: buildSourceCounts(input, contextPolicy),
      createdAt: new Date(),
    }
  }
}

function normalizeProjectInstructions(instructions, contextPolicy = {}) {
  if (contextPolicy.includeProjectInstructions !== true) {
    return null
  }
  if (!instructions?.content) return null
  const content = redact(String(instructions.content))
  return {
    content,
    path: safeInstructionPath(instructions.path || 'AGENTS.md'),
    refId: instructions.refId || instructions.docId || null,
    tokenEstimate: estimateTokens(content),
  }
}

function normalizeMemories(memories = [], contextPolicy = {}) {
  if (contextPolicy.includeMemories !== true) return []
  if (!Array.isArray(memories)) return []
  const maxMemories = normalizePositiveInteger(
    contextPolicy.maxMemories,
    DEFAULT_MAX_MEMORIES
  )
  const maxMemoryChars = normalizePositiveInteger(
    contextPolicy.maxMemoryChars,
    DEFAULT_MAX_MEMORY_CHARS
  )
  return memories.slice(0, maxMemories).map(memory => {
    const content = truncate(redact(memory.content || ''), maxMemoryChars)
    return {
      id: requireString(memory.id || memory._id?.toString?.() || memory._id, 'memory.id'),
      content,
      scope: SAFE_MEMORY_SCOPE.has(memory.scope) ? memory.scope : 'project',
      source: typeof memory.source === 'string' ? memory.source : 'manual',
      tokenEstimate: estimateTokens(content),
    }
  }).filter(memory => memory.content)
}

function normalizeSessionSummary(summary, contextPolicy = {}) {
  if (contextPolicy.includeSessionSummary !== true) return null
  if (!summary?.summary) return null
  const content = truncate(
    redact(summary.summary),
    normalizePositiveInteger(contextPolicy.maxSessionSummaryChars, DEFAULT_MAX_SUMMARY_CHARS)
  )
  return {
    id: summary.id || summary._id?.toString?.() || summary._id || null,
    summary: content,
    sourceMessageRange: sanitizeValue(summary.sourceMessageRange || null),
    tokenEstimate: summary.tokenEstimate || estimateTokens(content),
  }
}

function normalizeRecalledContext(items = [], contextPolicy = {}) {
  if (contextPolicy.includeRecalledContext !== true) return []
  if (!Array.isArray(items)) return []
  const maxRecallItems = normalizePositiveInteger(contextPolicy.maxRecallItems, 4)
  const maxRecallChars = normalizePositiveInteger(
    contextPolicy.maxRecallChars,
    DEFAULT_MAX_RECALL_CHARS
  )
  return items.slice(0, maxRecallItems).map(item => {
    const content = truncate(redact(item.content || ''), maxRecallChars)
    return {
      id: item.id || item.refId || null,
      type: SAFE_RECALL_TYPE.has(item.type) ? item.type : 'recall',
      content,
      sourceRef: item.sourceRef || item.refId || null,
      tokenEstimate: item.tokenEstimate || estimateTokens(content),
    }
  }).filter(item => item.content)
}

function buildSourceCounts(input, contextPolicy) {
  return {
    projectInstructions: normalizeProjectInstructions(input.projectInstructions, contextPolicy)
      ? 1
      : 0,
    memories: normalizeMemories(input.memories, contextPolicy).length,
    sessionSummary: normalizeSessionSummary(input.sessionSummary, contextPolicy) ? 1 : 0,
    recalledContext: normalizeRecalledContext(input.recalledContext, contextPolicy).length,
    files: Array.isArray(input.files) ? input.files.length : 0,
  }
}

function normalizeFiles(files = [], maxFileChars) {
  if (!Array.isArray(files)) return []
  return files.map(file => {
    const path = requireSafeRelativePath(file.path)
    const mode = SAFE_FILE_MODE.has(file.mode) ? file.mode : 'excerpt'
    const content = redact(String(file.content || ''))
    const truncated = truncate(content, maxFileChars)
    return {
      path,
      mode,
      content: truncated,
      contentRef: file.contentRef || null,
      reason: requireString(file.reason, 'file.reason'),
      tokenEstimate: estimateTokens(truncated),
    }
  })
}

function sanitizeDiagnostics(diagnostics = {}) {
  const sanitized = {}
  for (const [key, value] of Object.entries(diagnostics)) {
    if (SENSITIVE_KEY_RE.test(key)) continue
    sanitized[key] = sanitizeValue(value)
  }
  return sanitized
}

function sanitizeStructuredArray(values = []) {
  return Array.isArray(values) ? values.map(sanitizeValue) : []
}

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value && typeof value === 'object') {
    const output = {}
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(key)) continue
      output[key] = sanitizeValue(nested)
    }
    return output
  }
  if (typeof value === 'string') return redact(value)
  return value
}

function redact(value) {
  return String(value || '').replace(SECRET_VALUE_RE, '[REDACTED]')
}

function requireString(value, field) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`${field} is required`)
}

function requireSafeRelativePath(value) {
  const path = requireString(value, 'file.path')
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path === '..' ||
    path.startsWith('../') ||
    path.includes('/../')
  ) {
    throw new Error('Unsafe context file path')
  }
  return path
}

function safeInstructionPath(value) {
  const path = requireString(value, 'projectInstructions.path')
  if (path !== 'AGENTS.md') return requireSafeRelativePath(path)
  return path
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[truncated]`
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 4))
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback
}

export default AgentContextPackBuilder
