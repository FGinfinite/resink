const { EventEmitter } = require('node:events')

const redis = require('@overleaf/redis-wrapper')

const INVALIDATION_CHANNEL = 'app-config:invalidation'

function definition(opts) {
  return {
    runtimeEditable: true,
    secret: false,
    reloadStrategy: 'pubsub_refresh',
    envAliases: [],
    ...opts,
  }
}

function intDef(service, key, settingsPath, defaultValue, opts = {}) {
  return definition({
    service,
    key,
    settingsPath,
    type: 'int',
    default: defaultValue,
    ...opts,
  })
}

function floatDef(service, key, settingsPath, defaultValue, opts = {}) {
  return definition({
    service,
    key,
    settingsPath,
    type: 'float',
    default: defaultValue,
    ...opts,
  })
}

function boolDef(service, key, settingsPath, defaultValue, opts = {}) {
  return definition({
    service,
    key,
    settingsPath,
    type: 'boolean',
    default: defaultValue,
    ...opts,
  })
}

function enumDef(service, key, settingsPath, defaultValue, enumValues, opts = {}) {
  return definition({
    service,
    key,
    settingsPath,
    type: 'enum',
    default: defaultValue,
    enumValues,
    ...opts,
  })
}

const definitionsByService = {
  web: [
    boolDef(
      'web',
      'site.isOpen',
      ['siteIsOpen'],
      true,
      {
        label: 'Site Open',
        category: 'Operations',
        envAliases: ['SITE_OPEN'],
        reloadStrategy: 'immediate_in_memory',
        description: 'Controls whether the whole site accepts normal traffic.',
      }
    ),
    boolDef(
      'web',
      'editor.isOpen',
      ['editorIsOpen'],
      true,
      {
        label: 'Editor Open',
        category: 'Operations',
        envAliases: ['EDITOR_OPEN'],
        reloadStrategy: 'immediate_in_memory',
        description: 'Controls whether the editor remains open for users.',
      }
    ),
    intDef(
      'web',
      'defaultFeatures.compileTimeout',
      ['defaultFeatures', 'compileTimeout'],
      180,
      {
        label: 'Default Compile Timeout',
        category: 'Compile',
        description: 'Default compile timeout in seconds when the owner has no explicit feature override.',
      }
    ),
    enumDef(
      'web',
      'defaultFeatures.compileGroup',
      ['defaultFeatures', 'compileGroup'],
      'standard',
      ['standard', 'priority'],
      {
        label: 'Default Compile Group',
        category: 'Compile',
        description: 'Default compile group used when the owner has no explicit feature override.',
      }
    ),
    boolDef(
      'web',
      'pdfCaching.enabled',
      ['enablePdfCaching'],
      false,
      {
        label: 'Enable PDF Caching',
        category: 'Compile',
        description: 'Enables PDF caching for compatible compile flows.',
      }
    ),
    intDef(
      'web',
      'pdfCaching.minChunkSize',
      ['pdfCachingMinChunkSize'],
      1024,
      {
        label: 'PDF Caching Min Chunk Size',
        category: 'Compile',
        description: 'Minimum PDF chunk size used when PDF caching is enabled.',
      }
    ),
  ],
  'ai-writing-agent': [
    intDef(
      'ai-writing-agent',
      'modelConfig.cacheTtlMs',
      ['modelConfig', 'cacheTtlMs'],
      60000,
      {
        label: 'Model Config Cache TTL',
        category: 'AI Models',
        description: 'TTL for cached AI model configuration lookups.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'modelConfig.cacheMax',
      ['modelConfig', 'cacheMax'],
      100,
      {
        label: 'Model Config Cache Max',
        category: 'AI Models',
        description: 'Maximum number of cached AI model configuration entries.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'memory.maxRulesLength',
      ['memory', 'maxRulesLength'],
      10000,
      {
        label: 'Project Rules Max Length',
        category: 'Memory',
        description: 'Maximum number of characters allowed in project rules memory content.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'completionRules.maxLength',
      ['completionRules', 'maxLength'],
      2000,
      {
        label: 'Completion Rules Max Length',
        category: 'Autocomplete',
        description: 'Maximum number of characters allowed in completion rules content.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'image.maxSize',
      ['image', 'maxSize'],
      5 * 1024 * 1024,
      {
        label: 'Image Max Size',
        category: 'Attachments',
        description: 'Maximum size in bytes for AI image inputs and attachments.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'externalApis.timeout',
      ['externalApis', 'timeout'],
      10000,
      {
        label: 'External API Timeout',
        category: 'External APIs',
        description: 'Timeout in milliseconds for bibliography lookup external API calls.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'externalApis.maxRetries',
      ['externalApis', 'maxRetries'],
      2,
      {
        label: 'External API Max Retries',
        category: 'External APIs',
        description: 'Retry count for bibliography lookup external API calls.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'externalApis.maxResponseBytes',
      ['externalApis', 'maxResponseBytes'],
      5242880,
      {
        label: 'External API Max Response Bytes',
        category: 'External APIs',
        description: 'Maximum response payload size accepted from bibliography lookup providers.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'runBudget.maxWallTimeMs',
      ['runBudget', 'maxWallTimeMs'],
      1800000,
      {
        label: 'Run Budget Max Wall Time',
        category: 'Run Budget',
        description: 'Maximum wall clock time for one agent run, in milliseconds.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'runBudget.maxLLMCalls',
      ['runBudget', 'maxLLMCalls'],
      30,
      {
        label: 'Run Budget Max LLM Calls',
        category: 'Run Budget',
        description: 'Maximum number of LLM calls in one run.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'runBudget.maxToolCalls',
      ['runBudget', 'maxToolCalls'],
      70,
      {
        label: 'Run Budget Max Tool Calls',
        category: 'Run Budget',
        description: 'Maximum number of tool calls in one run.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'runBudget.maxTotalTokens',
      ['runBudget', 'maxTotalTokens'],
      200000,
      {
        label: 'Run Budget Max Total Tokens',
        category: 'Run Budget',
        description: 'Maximum total token budget in one run.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'runBudget.maxDepth',
      ['runBudget', 'maxDepth'],
      1,
      {
        label: 'Run Budget Max Depth',
        category: 'Run Budget',
        description: 'Maximum delegation depth in one run.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'runBudget.maxDelegations',
      ['runBudget', 'maxDelegations'],
      6,
      {
        label: 'Run Budget Max Delegations',
        category: 'Run Budget',
        description: 'Maximum number of delegations in one run.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'confirmationChannel.defaultTimeoutMs',
      ['confirmationChannel', 'defaultTimeoutMs'],
      1800000,
      {
        label: 'Confirmation Default Timeout',
        category: 'Confirmation',
        description: 'Default timeout for pending confirmations in milliseconds.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'confirmationChannel.maxPending',
      ['confirmationChannel', 'maxPending'],
      500,
      {
        label: 'Confirmation Max Pending',
        category: 'Confirmation',
        description: 'Maximum number of pending confirmations kept in memory.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'confirmationChannel.maxEarlyConfirmations',
      ['confirmationChannel', 'maxEarlyConfirmations'],
      100,
      {
        label: 'Confirmation Max Early Cache',
        category: 'Confirmation',
        description: 'Maximum number of cached early confirmations.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'confirmationChannel.earlyTtlMs',
      ['confirmationChannel', 'earlyTtlMs'],
      30000,
      {
        label: 'Confirmation Early TTL',
        category: 'Confirmation',
        description: 'TTL for early confirmations in milliseconds.',
      }
    ),
    intDef(
      'ai-writing-agent',
      'confirmationChannel.finalizedTtlMs',
      ['confirmationChannel', 'finalizedTtlMs'],
      60000,
      {
        label: 'Confirmation Finalized TTL',
        category: 'Confirmation',
        description: 'TTL for finalized confirmation ids in milliseconds.',
      }
    ),
  ],
  clsi: [
    intDef(
      'clsi',
      'compileConcurrencyLimit',
      ['compileConcurrencyLimit'],
      () => (process.env.PREEMPTIBLE === 'TRUE' ? 32 : 64),
      {
        label: 'Compile Concurrency Limit',
        category: 'Compile',
        description: 'Maximum number of concurrent compile requests accepted by CLSI.',
      }
    ),
    floatDef(
      'clsi',
      'performanceLogSamplingPercentage',
      ['performanceLogSamplingPercentage'],
      0,
      {
        label: 'Performance Log Sampling',
        category: 'Compile',
        description: 'Sampling percentage for performance logging.',
      }
    ),
    intDef(
      'clsi',
      'parallelFileDownloads',
      ['parallelFileDownloads'],
      1,
      {
        label: 'Parallel File Downloads',
        category: 'Compile',
        description: 'Parallel download limit when fetching compile resources.',
      }
    ),
    intDef(
      'clsi',
      'maxCompileTimeoutSeconds',
      ['maxCompileTimeoutSeconds'],
      600,
      {
        label: 'Max Compile Timeout',
        category: 'Compile',
        description: 'Maximum compile timeout accepted by CLSI, in seconds.',
      }
    ),
    intDef(
      'clsi',
      'requestTimeoutMs',
      ['requestTimeoutMs'],
      600000,
      {
        label: 'CLSI Request Timeout',
        category: 'Compile',
        description: 'HTTP request timeout for CLSI compile endpoints, in milliseconds.',
      }
    ),
    boolDef(
      'clsi',
      'pdfCaching.enabled',
      ['enablePdfCaching'],
      false,
      {
        label: 'Enable PDF Caching',
        category: 'PDF Caching',
        description: 'Enables standard PDF caching in CLSI.',
      }
    ),
    boolDef(
      'clsi',
      'pdfCaching.enableDark',
      ['enablePdfCachingDark'],
      false,
      {
        label: 'Enable Dark PDF Caching',
        category: 'PDF Caching',
        description: 'Enables dark-mode PDF caching in CLSI.',
      }
    ),
    intDef(
      'clsi',
      'pdfCaching.minChunkSize',
      ['pdfCachingMinChunkSize'],
      1024,
      {
        label: 'PDF Caching Min Chunk Size',
        category: 'PDF Caching',
        description: 'Minimum PDF chunk size eligible for caching.',
      }
    ),
    intDef(
      'clsi',
      'pdfCaching.maxProcessingTime',
      ['pdfCachingMaxProcessingTime'],
      10000,
      {
        label: 'PDF Caching Max Processing Time',
        category: 'PDF Caching',
        description: 'Maximum processing time for PDF caching work in milliseconds.',
      }
    ),
  ],
}

function getDefinitionsForService(service) {
  return definitionsByService[service] || []
}

function getDefaultValue(definition) {
  if (typeof definition.default === 'function') {
    return definition.default()
  }
  return cloneValue(definition.default)
}

function cloneValue(value) {
  if (value == null || typeof value !== 'object') {
    return value
  }
  return JSON.parse(JSON.stringify(value))
}

function normalizeValue(definition, input) {
  if (input == null) {
    return null
  }

  switch (definition.type) {
    case 'boolean':
      return normalizeBoolean(input, definition.key)
    case 'int':
      return normalizeInt(input, definition.key)
    case 'float':
      return normalizeFloat(input, definition.key)
    case 'enum': {
      const value = String(input)
      if (!definition.enumValues?.includes(value)) {
        throw new Error(
          `${definition.key} must be one of: ${definition.enumValues.join(', ')}`
        )
      }
      return value
    }
    case 'json':
      return normalizeJson(input, definition.key)
    case 'string':
    default:
      return String(input)
  }
}

function normalizeBoolean(input, key) {
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') return input !== 0
  if (typeof input === 'string') {
    const value = input.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(value)) return true
    if (['false', '0', 'no', 'off'].includes(value)) return false
  }
  throw new Error(`${key} must be a boolean`)
}

function normalizeInt(input, key) {
  const value = Number.parseInt(input, 10)
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be an integer`)
  }
  return value
}

function normalizeFloat(input, key) {
  const value = Number.parseFloat(input)
  if (!Number.isFinite(value)) {
    throw new Error(`${key} must be a number`)
  }
  return value
}

function normalizeJson(input, key) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input)
    } catch (error) {
      throw new Error(`${key} must be valid JSON`)
    }
  }
  if (typeof input === 'object') {
    return cloneValue(input)
  }
  throw new Error(`${key} must be JSON`)
}

function getByPath(target, path) {
  let current = target
  for (const part of path || []) {
    if (current == null) return undefined
    current = current[part]
  }
  return current
}

function setByPath(target, path, value) {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error('settingsPath must be a non-empty array')
  }
  let current = target
  for (const part of path.slice(0, -1)) {
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part]
  }
  current[path[path.length - 1]] = cloneValue(value)
}

function firstDefinedEnvValue(env, aliases = []) {
  for (const name of aliases) {
    if (env[name] !== undefined && env[name] !== '') {
      return { name, value: env[name] }
    }
  }
  return null
}

class ConfigManager extends EventEmitter {
  constructor(options) {
    super()
    const {
      service,
      collections,
      definitions,
      redisConfig,
      logger = console,
      cacheTtlMs = 30000,
    } = options
    this.service = service
    this.collections = collections
    this.definitions = (definitions || []).slice().sort((left, right) =>
      left.key.localeCompare(right.key)
    )
    this.definitionMap = new Map(
      this.definitions.map(definition => [definition.key, definition])
    )
    this.redisConfig = redisConfig
    this.logger = logger
    this.cacheTtlMs = cacheTtlMs
    this._cachedRuntimeValues = null
    this._subscriber = null
  }

  async ensureIndexes() {
    await Promise.all([
      this.collections.values.createIndex(
        { service: 1, key: 1 },
        { unique: true }
      ),
      this.collections.revisions.createIndex(
        { service: 1, key: 1, version: -1 }
      ),
      this.collections.auditLogs.createIndex(
        { service: 1, key: 1, createdAt: -1 }
      ),
    ])
  }

  async start() {
    if (!this.redisConfig || this._subscriber) {
      return
    }
    this._subscriber = redis.createClient(this.redisConfig)
    await this._subscriber.subscribe(INVALIDATION_CHANNEL)
    this._subscriber.on('message', (_channel, payload) => {
      try {
        const event = JSON.parse(payload)
        if (event.service && event.service !== this.service) {
          return
        }
        this.invalidateCache()
        this.emit('updated', event)
      } catch (error) {
        this.logger.warn?.(
          { err: error, payload },
          'failed to parse runtime config invalidation payload'
        )
      }
    })
  }

  async stop() {
    if (!this._subscriber) return
    try {
      await this._subscriber.unsubscribe(INVALIDATION_CHANNEL)
    } catch (error) {
      this.logger.warn?.(
        { err: error },
        'failed to unsubscribe runtime config invalidation channel'
      )
    }
    try {
      await this._subscriber.disconnect()
    } catch (error) {
      this.logger.warn?.(
        { err: error },
        'failed to disconnect runtime config subscriber'
      )
    }
    this._subscriber = null
  }

  invalidateCache() {
    this._cachedRuntimeValues = null
  }

  async _getRuntimeValueMap({ force = false } = {}) {
    if (
      !force &&
      this._cachedRuntimeValues &&
      Date.now() - this._cachedRuntimeValues.ts < this.cacheTtlMs
    ) {
      return this._cachedRuntimeValues.map
    }

    const docs = await this.collections.values
      .find({ service: this.service })
      .toArray()

    const map = new Map(docs.map(doc => [doc.key, doc]))
    this._cachedRuntimeValues = { ts: Date.now(), map }
    return map
  }

  async listDefinitions() {
    return this.definitions.map(definition => ({
      ...definition,
      default: getDefaultValue(definition),
    }))
  }

  async listResolvedEntries({ env = process.env } = {}) {
    const runtimeMap = await this._getRuntimeValueMap()
    return this.definitions.map(definition =>
      this._buildResolvedEntry(definition, runtimeMap, env)
    )
  }

  async getResolvedEntry(key, { env = process.env } = {}) {
    const definition = this._getDefinition(key)
    const runtimeMap = await this._getRuntimeValueMap()
    return this._buildResolvedEntry(definition, runtimeMap, env)
  }

  async getRevisions(key, limit = 50) {
    this._getDefinition(key)
    return this.collections.revisions
      .find({ service: this.service, key })
      .sort({ version: -1 })
      .limit(limit)
      .toArray()
  }

  async setRuntimeValue({ key, value, updatedBy, comment = '' }) {
    const definition = this._getDefinition(key)
    if (!definition.runtimeEditable || definition.secret) {
      throw new Error(`${key} is not runtime editable`)
    }

    const normalizedValue = normalizeValue(definition, value)
    const current = await this.collections.values.findOne({
      service: this.service,
      key,
    })
    const nextVersion = await this._getNextVersion(key, current?.version || 0)
    const now = new Date()

    const currentDoc = {
      service: this.service,
      key,
      value: cloneValue(value),
      normalizedValue,
      version: nextVersion,
      updatedBy,
      comment,
      createdAt: current?.createdAt || now,
      updatedAt: now,
    }

    await this.collections.values.updateOne(
      { service: this.service, key },
      { $set: currentDoc },
      { upsert: true }
    )

    await this.collections.revisions.insertOne({
      service: this.service,
      key,
      version: nextVersion,
      action: 'set',
      value: cloneValue(value),
      normalizedValue,
      previousValue: current?.normalizedValue ?? null,
      previousVersion: current?.version ?? null,
      updatedBy,
      comment,
      createdAt: now,
    })

    await this.collections.auditLogs.insertOne({
      service: this.service,
      key,
      action: 'set',
      version: nextVersion,
      previousValue: current?.normalizedValue ?? null,
      nextValue: normalizedValue,
      updatedBy,
      comment,
      createdAt: now,
    })

    const event = {
      service: this.service,
      keys: [key],
      action: 'set',
      version: nextVersion,
    }

    this.invalidateCache()
    this.emit('updated', event)
    await this._publishInvalidation(event)

    return currentDoc
  }

  async resetRuntimeValue({ key, updatedBy, comment = '' }) {
    const definition = this._getDefinition(key)
    if (!definition.runtimeEditable || definition.secret) {
      throw new Error(`${key} is not runtime editable`)
    }

    const current = await this.collections.values.findOne({
      service: this.service,
      key,
    })
    if (!current) {
      return null
    }

    const nextVersion = await this._getNextVersion(key, current.version)
    const now = new Date()

    await this.collections.values.deleteOne({ service: this.service, key })

    await this.collections.revisions.insertOne({
      service: this.service,
      key,
      version: nextVersion,
      action: 'reset',
      value: null,
      normalizedValue: null,
      previousValue: current.normalizedValue ?? null,
      previousVersion: current.version ?? null,
      updatedBy,
      comment,
      createdAt: now,
    })

    await this.collections.auditLogs.insertOne({
      service: this.service,
      key,
      action: 'reset',
      version: nextVersion,
      previousValue: current.normalizedValue ?? null,
      nextValue: getDefaultValue(definition),
      updatedBy,
      comment,
      createdAt: now,
    })

    const event = {
      service: this.service,
      keys: [key],
      action: 'reset',
      version: nextVersion,
    }

    this.invalidateCache()
    this.emit('updated', event)
    await this._publishInvalidation(event)

    return { service: this.service, key, version: nextVersion }
  }

  async rollbackRuntimeValue({ key, version, updatedBy, comment = '' }) {
    const revision = await this.collections.revisions.findOne({
      service: this.service,
      key,
      version,
    })
    if (!revision) {
      throw new Error(`No revision ${version} found for ${this.service}:${key}`)
    }

    if (revision.action === 'reset') {
      return this.resetRuntimeValue({
        key,
        updatedBy,
        comment: comment || `Rollback to revision ${version}`,
      })
    }

    return this.setRuntimeValue({
      key,
      value: revision.value,
      updatedBy,
      comment: comment || `Rollback to revision ${version}`,
    })
  }

  async applyResolvedSettings(target, { env = process.env } = {}) {
    const runtimeMap = await this._getRuntimeValueMap()
    for (const definition of this.definitions) {
      const entry = this._buildResolvedEntry(definition, runtimeMap, env)
      setByPath(target, definition.settingsPath, entry.resolvedValue)
    }
    return target
  }

  _buildResolvedEntry(definition, runtimeMap, env) {
    const defaultValue = getDefaultValue(definition)
    const runtimeValue = runtimeMap.get(definition.key)
    const envValue = firstDefinedEnvValue(env, definition.envAliases)

    let resolvedValue = defaultValue
    let source = 'default'
    if (envValue) {
      try {
        resolvedValue = normalizeValue(definition, envValue.value)
        source = 'env'
      } catch (error) {
        resolvedValue = defaultValue
      }
    }
    if (runtimeValue) {
      resolvedValue = cloneValue(runtimeValue.normalizedValue)
      source = 'runtime'
    }

    return {
      key: definition.key,
      service: definition.service,
      label: definition.label,
      category: definition.category,
      description: definition.description,
      type: definition.type,
      enumValues: definition.enumValues || [],
      envAliases: definition.envAliases || [],
      reloadStrategy: definition.reloadStrategy,
      runtimeEditable: definition.runtimeEditable,
      defaultValue,
      resolvedValue,
      source,
      runtimeVersion: runtimeValue?.version || null,
      updatedAt: runtimeValue?.updatedAt || null,
      updatedBy: runtimeValue?.updatedBy || null,
      comment: runtimeValue?.comment || '',
    }
  }

  _getDefinition(key) {
    const definition = this.definitionMap.get(key)
    if (!definition) {
      throw new Error(`Unknown config key: ${this.service}:${key}`)
    }
    return definition
  }

  async _getNextVersion(key, currentVersion = 0) {
    const latestRevision = await this.collections.revisions
      .find({ service: this.service, key })
      .sort({ version: -1 })
      .limit(1)
      .toArray()

    const latestVersion = latestRevision[0]?.version || 0
    return Math.max(currentVersion, latestVersion) + 1
  }

  async _publishInvalidation(event) {
    if (!this.redisConfig) {
      return
    }
    const client = redis.createClient(this.redisConfig)
    try {
      await client.publish(INVALIDATION_CHANNEL, JSON.stringify(event))
    } finally {
      try {
        await client.disconnect()
      } catch (error) {
        this.logger.warn?.(
          { err: error },
          'failed to disconnect runtime config publisher'
        )
      }
    }
  }
}

module.exports = {
  ConfigManager,
  INVALIDATION_CHANNEL,
  definitionsByService,
  getDefinitionsForService,
  getByPath,
  setByPath,
  normalizeValue,
}
