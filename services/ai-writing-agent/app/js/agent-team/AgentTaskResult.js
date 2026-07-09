const VALID_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout'])
const VALID_SEVERITIES = new Set(['critical', 'major', 'minor', 'question'])
const VALID_CATEGORIES = new Set([
  'method',
  'experiment',
  'evidence',
  'clarity',
  'significance',
  'originality',
  'citation',
  'formatting',
  'consistency',
  'other',
])
const HIGH_SEVERITY = new Set(['critical', 'major'])
const MAX_TEXT = 4000

export class AgentTaskResultError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'AgentTaskResultError'
    this.code = 'AGENT_TASK_RESULT_INVALID'
    this.info = info
  }
}

export function normalizeAgentTaskResult(input = {}) {
  if (!isPlainObject(input)) {
    throwResultError('Agent task result must be an object', 'invalid-result')
  }
  const status = normalizeStatus(input.status)
  const summary = normalizeRequiredText(input.summary, 'summary')
  const findings = normalizeFindings(input.findings)
  return {
    status,
    summary,
    findings,
    proposedEdits: normalizeStructuredArray(input.proposedEdits),
    artifacts: normalizeStructuredArray(input.artifacts),
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs),
    unresolvedQuestions: normalizeStringArray(input.unresolvedQuestions),
    confidence: normalizeConfidence(input.confidence),
    nextActions: normalizeStructuredArray(input.nextActions),
  }
}

export function normalizeFinding(input, index = 0) {
  if (!isPlainObject(input)) {
    throwResultError('finding must be an object', 'invalid-finding', { index })
  }
  const severity = normalizeEnum(
    input.severity,
    VALID_SEVERITIES,
    `findings[${index}].severity`
  )
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs)
  if (HIGH_SEVERITY.has(severity) && evidenceRefs.length === 0) {
    throwResultError(
      'major and critical findings require at least one evidence ref',
      'missing-evidence',
      { index, severity }
    )
  }
  return {
    id: normalizeOptionalText(input.id),
    severity,
    category: normalizeEnum(
      input.category || 'other',
      VALID_CATEGORIES,
      `findings[${index}].category`
    ),
    title: normalizeRequiredText(input.title, `findings[${index}].title`),
    description: normalizeRequiredText(
      input.description,
      `findings[${index}].description`
    ),
    evidenceRefs,
    suggestedFix: normalizeOptionalText(input.suggestedFix),
    confidence: normalizeConfidence(input.confidence),
    duplicateOf: normalizeOptionalText(input.duplicateOf),
    sourceTaskId: normalizeOptionalText(input.sourceTaskId),
    sourceTaskIds: normalizeStringArray(input.sourceTaskIds),
    sourceAgents: normalizeStringArray(input.sourceAgents),
  }
}

function normalizeFindings(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throwResultError('findings must be an array', 'invalid-findings')
  }
  return value.map((finding, index) => normalizeFinding(finding, index))
}

function normalizeEvidenceRefs(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throwResultError('evidenceRefs must be an array', 'invalid-evidence-refs')
  }
  return value.map((ref, index) => {
    if (!isPlainObject(ref)) {
      throwResultError('evidence ref must be an object', 'invalid-evidence-ref', {
        index,
      })
    }
    return {
      path: normalizeRequiredText(ref.path, `evidenceRefs[${index}].path`),
      locator: normalizeOptionalText(ref.locator),
      quote: normalizeOptionalText(ref.quote),
      reason: normalizeOptionalText(ref.reason),
    }
  })
}

function normalizeStatus(value) {
  return normalizeEnum(value || 'completed', VALID_STATUSES, 'status')
}

function normalizeEnum(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.has(value.trim())) {
    throwResultError(`${field} is not supported`, 'invalid-enum', { field })
  }
  return value.trim()
}

function normalizeRequiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throwResultError(`${field} must be a non-empty string`, 'invalid-text', {
      field,
    })
  }
  return value.trim().slice(0, MAX_TEXT)
}

function normalizeOptionalText(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim().slice(0, MAX_TEXT)
}

function normalizeConfidence(value) {
  if (value === undefined || value === null) return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throwResultError('confidence must be numeric', 'invalid-confidence')
  }
  return Math.max(0, Math.min(1, numeric))
}

function normalizeStringArray(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throwResultError('field must be an array', 'invalid-array')
  }
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => item.trim().slice(0, MAX_TEXT))
}

function normalizeStructuredArray(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throwResultError('field must be an array', 'invalid-array')
  }
  return value.map(item => sanitizeStructuredValue(item))
}

function sanitizeStructuredValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeStructuredValue)
  if (!isPlainObject(value)) return value
  const sanitized = {}
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue
    sanitized[key] = sanitizeStructuredValue(nested)
  }
  return sanitized
}

function isSensitiveKey(key) {
  return /(?:prompt|hiddenPrompt|systemPrompt|apiKey|token|secret|password|credential)/i.test(key)
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function throwResultError(message, reason, info = {}) {
  throw new AgentTaskResultError(message, { reason, ...info })
}

export default normalizeAgentTaskResult
