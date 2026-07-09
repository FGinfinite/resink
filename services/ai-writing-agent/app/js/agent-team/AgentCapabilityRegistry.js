import logger from '@overleaf/logger'

const NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/i
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9_.-]+)?$/
const VALID_ROLES = new Set([
  'worker',
  'coordinator',
  'critic',
  'reducer',
  'handoff-specialist',
  'background-explorer',
])

export class AgentCapabilityRegistry {
  constructor(options = {}) {
    this.definitions = options.definitions || []
    this.skillRegistry = options.skillRegistry || null
    this.activatedSkillNames = options.activatedSkillNames || []
    this.logger = options.logger || logger
    this.capabilities = new Map()
    this.diagnostics = { loaded: 0, skipped: [] }
  }

  async loadAll() {
    this.capabilities.clear()
    this.diagnostics = { loaded: 0, skipped: [] }

    for (const definition of this.collectDefinitions()) {
      const validation = validateCapability(definition)
      if (!validation.ok) {
        this.diagnostics.skipped.push({
          name: definition?.name || null,
          reason: validation.reason,
        })
        this.logger.warn(
          { name: definition?.name, reason: validation.reason },
          'Skipping invalid agent capability'
        )
        continue
      }
      if (this.capabilities.has(definition.name)) {
        this.diagnostics.skipped.push({
          name: definition.name,
          reason: 'duplicate-capability-name',
        })
        this.logger.warn(
          { name: definition.name },
          'Skipping duplicate agent capability'
        )
        continue
      }
      this.capabilities.set(definition.name, freezeCapability(definition))
    }

    this.diagnostics.loaded = this.capabilities.size
    return {
      loaded: this.diagnostics.loaded,
      skipped: [...this.diagnostics.skipped],
    }
  }

  get(name) {
    return this.capabilities.get(name)
  }

  listMetadata() {
    return Array.from(this.capabilities.values()).map(capability => ({
      name: capability.name,
      version: capability.version,
      description: capability.description,
      role: capability.role,
      triggerHints: capability.triggerHints,
      inputSchema: capability.inputSchema,
      outputSchema: capability.outputSchema,
      defaultModelTier: capability.defaultModelTier,
      defaultToolsets: capability.defaultToolsets,
      defaultPolicy: capability.defaultPolicy,
      contextPolicy: capability.contextPolicy,
      promptRef: sanitizePromptRefForMetadata(capability.promptRef),
      examples: capability.examples,
      safety: capability.safety,
      provenance: capability.provenance,
    }))
  }

  collectDefinitions() {
    const definitions = [...this.definitions]
    for (const skillName of this.activatedSkillNames) {
      const skill = this.skillRegistry?.get?.(skillName)
      for (const capability of skill?.agentCapabilities || []) {
        definitions.push({
          ...capability,
          provenance: capability.provenance || {
            source: 'skill-package',
            skillName,
          },
        })
      }
    }
    return definitions
  }
}

function validateCapability(definition) {
  if (!definition || typeof definition !== 'object') {
    return { ok: false, reason: 'capability-must-be-object' }
  }
  if (!NAME_RE.test(definition.name || '')) {
    return { ok: false, reason: 'invalid-name' }
  }
  if (!VERSION_RE.test(definition.version || '')) {
    return { ok: false, reason: 'invalid-version' }
  }
  if (typeof definition.description !== 'string' || !definition.description.trim()) {
    return { ok: false, reason: 'missing-description' }
  }
  if (!VALID_ROLES.has(definition.role)) {
    return { ok: false, reason: 'invalid-role' }
  }
  if (!isPromptRef(definition.promptRef)) {
    return { ok: false, reason: 'invalid-prompt-ref' }
  }
  if (!isJsonObjectSchema(definition.inputSchema)) {
    return { ok: false, reason: 'invalid-input-schema' }
  }
  if (!isJsonObjectSchema(definition.outputSchema)) {
    return { ok: false, reason: 'invalid-output-schema' }
  }
  return { ok: true }
}

function isPromptRef(promptRef) {
  if (!promptRef || typeof promptRef !== 'object' || typeof promptRef.kind !== 'string') {
    return false
  }
  if (promptRef.kind === 'builtin-agent-prompt') {
    return typeof promptRef.prompt === 'string' && promptRef.prompt.trim().length > 0
  }
  return Boolean(
    typeof promptRef.ref === 'string' &&
    promptRef.kind.trim() &&
    promptRef.ref.trim() &&
    !promptRef.ref.includes('..')
  )
}

function isJsonObjectSchema(schema) {
  return Boolean(schema && typeof schema === 'object' && schema.type === 'object')
}

function freezeCapability(definition) {
  return deepFreeze({
    name: definition.name,
    version: definition.version,
    description: definition.description.trim(),
    role: definition.role,
    triggerHints: normalizeStringArray(definition.triggerHints),
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    defaultModelTier: definition.defaultModelTier || 'standard',
    defaultToolsets: normalizeStringArray(definition.defaultToolsets),
    defaultPolicy: definition.defaultPolicy || {},
    contextPolicy: definition.contextPolicy || {},
    promptRef: definition.promptRef,
    examples: Array.isArray(definition.examples) ? definition.examples : [],
    safety: definition.safety || { classification: 'standard' },
    provenance: definition.provenance
      ? { ...definition.provenance }
      : { source: 'built-in' },
  })
}

function sanitizePromptRefForMetadata(promptRef) {
  if (promptRef?.kind === 'builtin-agent-prompt') {
    return { kind: 'builtin-agent-prompt' }
  }
  return promptRef
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : []
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return value
}

export default AgentCapabilityRegistry
