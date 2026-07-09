const VALID_MODES = new Set([
  'tool',
  'handoff',
  'background',
  'workflow-node',
  'reducer',
  'critic',
])

const ALLOWED_FIELDS = new Set([
  'teamId',
  'parentTaskId',
  'rootSessionId',
  'capabilityName',
  'capabilityVersion',
  'mode',
  'objective',
  'acceptanceCriteria',
  'input',
  'outputSchema',
  'contextPolicy',
  'policy',
  'dependencies',
  'priority',
  'timeoutMs',
  'retryPolicy',
])

const SENSITIVE_FIELD_KEYS = new Set([
  'prompt',
  'systemprompt',
  'hiddenprompt',
  'rawprompt',
  'apikey',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'secret',
  'secretkey',
  'rawsecret',
  'password',
  'passphrase',
])

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/
const SAFE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9_.-]+)?$/
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 3600000

export class AgentTaskSpecError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'AgentTaskSpecError'
    this.code = 'AGENT_TASK_SPEC_INVALID'
    this.info = info
  }
}

export function normalizeAgentTaskSpec(input) {
  if (!isPlainObject(input)) {
    throwSpecError('Agent task spec must be an object', 'invalid-spec')
  }

  rejectSensitiveFields(input)
  rejectUnknownFields(input)

  const capabilityName = normalizeRequiredSafeName(
    input.capabilityName,
    'capabilityName'
  )
  const mode = normalizeMode(input.mode)
  const objective = normalizeRequiredString(input.objective, 'objective')
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    input.acceptanceCriteria
  )
  const outputSchema = normalizeOutputSchema(input.outputSchema)

  return {
    teamId: normalizeOptionalSafeId(input.teamId, 'teamId'),
    parentTaskId: normalizeOptionalSafeId(input.parentTaskId, 'parentTaskId'),
    rootSessionId: normalizeOptionalSafeId(input.rootSessionId, 'rootSessionId'),
    capabilityName,
    capabilityVersion: normalizeOptionalVersion(input.capabilityVersion),
    mode,
    objective,
    acceptanceCriteria,
    input: normalizeOptionalObject(input.input, 'input'),
    outputSchema,
    contextPolicy: normalizeOptionalObject(input.contextPolicy, 'contextPolicy'),
    policy: normalizeOptionalObject(input.policy, 'policy'),
    dependencies: normalizeDependencies(input.dependencies),
    priority: normalizePriority(input.priority),
    timeoutMs: normalizeTimeoutMs(input.timeoutMs),
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
  }
}

function rejectUnknownFields(value) {
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throwSpecError(`Unsupported agent task spec field: ${key}`, 'unknown-field', {
        field: key,
      })
    }
  }
}

function rejectSensitiveFields(value, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, [...path, index]))
    return
  }
  if (!isPlainObject(value)) return

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_FIELD_KEYS.has(normalizeFieldKey(key))) {
      throwSpecError(
        `Sensitive field is not allowed in agent task specs: ${key}`,
        'sensitive-field',
        { field: key, path: [...path, key].join('.') }
      )
    }
    rejectSensitiveFields(nested, [...path, key])
  }
}

function normalizeFieldKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function normalizeRequiredSafeName(value, field) {
  const normalized = normalizeRequiredString(value, field)
  if (!SAFE_NAME_RE.test(normalized)) {
    throwSpecError(`${field} must use a safe capability name`, 'invalid-name', {
      field,
    })
  }
  return normalized
}

function normalizeMode(value) {
  const normalized = normalizeRequiredString(value, 'mode')
  if (!VALID_MODES.has(normalized)) {
    throwSpecError('mode is not supported', 'invalid-mode', { field: 'mode' })
  }
  return normalized
}

function normalizeRequiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throwSpecError(`${field} must be a non-empty string`, 'invalid-string', {
      field,
    })
  }
  return value.trim()
}

function normalizeAcceptanceCriteria(value) {
  const rawItems = Array.isArray(value) ? value : [value]
  const normalized = [
    ...new Set(
      rawItems
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    ),
  ]

  if (normalized.length === 0) {
    throwSpecError(
      'acceptanceCriteria must contain at least one non-empty string',
      'invalid-acceptance-criteria',
      { field: 'acceptanceCriteria' }
    )
  }
  return normalized
}

function normalizeOutputSchema(value) {
  if (!isPlainObject(value) || value.type !== 'object') {
    throwSpecError(
      'outputSchema must be a JSON object schema',
      'invalid-output-schema',
      { field: 'outputSchema' }
    )
  }
  return value
}

function normalizeOptionalObject(value, field) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throwSpecError(`${field} must be an object`, 'invalid-object', { field })
  }
  return value
}

function normalizeOptionalSafeId(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value.trim())) {
    throwSpecError(`${field} must be a safe id string`, 'invalid-id', { field })
  }
  return value.trim()
}

function normalizeOptionalVersion(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !VERSION_RE.test(value.trim())) {
    throwSpecError(
      'capabilityVersion must be a semantic version string',
      'invalid-version',
      { field: 'capabilityVersion' }
    )
  }
  return value.trim()
}

function normalizeDependencies(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throwSpecError('dependencies must be an array', 'invalid-dependencies', {
      field: 'dependencies',
    })
  }

  const normalized = value.map(item => {
    if (typeof item !== 'string' || !SAFE_ID_RE.test(item.trim())) {
      throwSpecError(
        'dependencies must contain only safe id strings',
        'invalid-dependency',
        { field: 'dependencies' }
      )
    }
    return item.trim()
  })

  return [...new Set(normalized)]
}

function normalizePriority(value) {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throwSpecError(
      'priority must be a non-negative integer',
      'invalid-priority',
      { field: 'priority' }
    )
  }
  return value
}

function normalizeTimeoutMs(value) {
  if (value === undefined) return null
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    throwSpecError(
      `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
      'invalid-timeout',
      { field: 'timeoutMs' }
    )
  }
  return value
}

function normalizeRetryPolicy(value) {
  if (value === undefined) {
    return {
      maxAttempts: 1,
      backoffMs: 0,
    }
  }
  if (!isPlainObject(value)) {
    throwSpecError('retryPolicy must be an object', 'invalid-retry-policy', {
      field: 'retryPolicy',
    })
  }

  const maxAttempts = value.maxAttempts ?? 1
  const backoffMs = value.backoffMs ?? 0

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throwSpecError(
      'retryPolicy.maxAttempts must be a positive integer',
      'invalid-retry-policy',
      { field: 'retryPolicy.maxAttempts' }
    )
  }
  if (!Number.isSafeInteger(backoffMs) || backoffMs < 0) {
    throwSpecError(
      'retryPolicy.backoffMs must be a non-negative integer',
      'invalid-retry-policy',
      { field: 'retryPolicy.backoffMs' }
    )
  }

  return {
    maxAttempts,
    backoffMs,
  }
}

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
  )
}

function throwSpecError(message, reason, info = {}) {
  throw new AgentTaskSpecError(message, {
    reason,
    ...info,
  })
}
