import settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import ConfigSystem from '@overleaf/config-system'
import { db } from './mongodb.js'

const { ConfigManager, definitionsByService } = ConfigSystem

const collections = {
  values: db.appConfigValues,
  revisions: db.appConfigRevisions,
  auditLogs: db.appConfigAuditLogs,
}

const manager = new ConfigManager({
  service: 'ai-writing-agent',
  collections,
  definitions: definitionsByService['ai-writing-agent'] || [],
  redisConfig: settings.redis?.pubsub,
  logger,
  cacheTtlMs: settings.runtimeConfig?.cacheTtlMs,
})

export const RUNTIME_MODES = new Set([
  'legacy',
  'sandbox-v0',
  'agent-loop-v2',
  'auto',
])

const LEGACY_RUNTIME_MODE_ALIASES = new Map([['sandbox', 'sandbox-v0']])
const PRODUCT_RUNTIME_MODE = 'agent-loop-v2'

function withDefault(value, defaultValue) {
  return value === undefined || value === null ? defaultValue : value
}

function sanitizeRuntimeMode(runtimeMode) {
  const normalized = LEGACY_RUNTIME_MODE_ALIASES.get(runtimeMode) || runtimeMode
  return RUNTIME_MODES.has(normalized) ? normalized : PRODUCT_RUNTIME_MODE
}

function hasConfiguredValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function sanitizeApiBase(value) {
  if (!hasConfiguredValue(value)) return value
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return '[redacted-invalid-url]'
  }
}

function resolveRuntimeMode(runtimeMode, sandbox, agentRuntime) {
  if (runtimeMode !== 'auto') return runtimeMode
  if (
    agentRuntime.agentLoopV2?.enabled !== false &&
    hasConfiguredValue(agentRuntime.agentLoopV2.apiBase) &&
    hasConfiguredValue(agentRuntime.agentLoopV2.model)
  ) {
    return 'agent-loop-v2'
  }
  return PRODUCT_RUNTIME_MODE
}

function resolveSandboxProviderCapabilities(provider) {
  return {
    immutableRuntimeEnvironmentMount: provider === 'local-docker',
  }
}

function resolveAgentContextConfig(agentContext = {}) {
  return {
    enabled: agentContext.enabled !== false,
    projectInstructionsFile: withDefault(
      agentContext.projectInstructionsFile,
      'AGENTS.md'
    ),
    maxInstructionChars: agentContext.maxInstructionChars ?? 40000,
    maxMemoryChars: agentContext.maxMemoryChars ?? 2000,
    maxMemoriesPerTurn: agentContext.maxMemoriesPerTurn ?? 12,
    maxRecallChars: agentContext.maxRecallChars ?? 6000,
    recallEnabled: agentContext.recallEnabled !== false,
    suggestionTtlMs: agentContext.suggestionTtlMs ?? 2592000000,
    blockSecretLookingContent:
      agentContext.blockSecretLookingContent !== false,
    blockPromptInjectionLookingContent:
      agentContext.blockPromptInjectionLookingContent !== false,
  }
}

export function getAgentRuntimeConfig(currentSettings = settings) {
  const aiAssistant = currentSettings.aiAssistant || {}
  const sandbox = aiAssistant.sandbox || {}
  const agentRuntime = aiAssistant.agentRuntime || {}
  const agentContext = resolveAgentContextConfig(aiAssistant.agentContext || {})
  const configuredRuntimeMode = sanitizeRuntimeMode(
    aiAssistant.runtimeMode || PRODUCT_RUNTIME_MODE
  )
  const sandboxConfig = {
    provider: withDefault(sandbox.provider, 'local-docker'),
    image: withDefault(sandbox.image, 'resink-ai-sandbox:dev'),
    rootDir: withDefault(sandbox.rootDir, null),
    dockerRootDir: withDefault(sandbox.dockerRootDir, null),
    e2bTemplate: withDefault(sandbox.e2bTemplate, null),
    e2bApiKey: withDefault(sandbox.e2bApiKey, null),
    workspaceTtlMs: sandbox.workspaceTtlMs ?? 86400000,
    commandTimeoutMs: sandbox.commandTimeoutMs ?? 120000,
    maxOutputBytes: sandbox.maxOutputBytes ?? 2000000,
    maxArtifactBytes: sandbox.maxArtifactBytes ?? 50000000,
    maxFileCount: sandbox.maxFileCount ?? 5000,
    memoryBytes: sandbox.memoryBytes ?? 536870912,
    memorySwapBytes: sandbox.memorySwapBytes ?? 536870912,
    cpuCount: sandbox.cpuCount ?? 1,
    pidsLimit: sandbox.pidsLimit ?? 256,
    networkPolicy: withDefault(sandbox.networkPolicy, 'deny'),
  }
  const agentRuntimeConfig = {
    // External coding CLIs are kept as experimental fallback tools for sandbox-v0.
    adapter: withDefault(agentRuntime.adapter, 'opencode'),
    executable: withDefault(agentRuntime.executable, 'opencode'),
    model: withDefault(agentRuntime.model, null),
    reasoningEffort: withDefault(agentRuntime.reasoningEffort, null),
    sandboxMode: withDefault(agentRuntime.sandboxMode, null),
    defaultProfile: withDefault(agentRuntime.defaultProfile, 'paper-reviewer'),
    eventFormat: withDefault(agentRuntime.eventFormat, 'json'),
    agentLoopV2: {
      enabled: agentRuntime.agentLoopV2?.enabled !== false,
      apiBase: withDefault(agentRuntime.agentLoopV2?.apiBase, null),
      model: withDefault(agentRuntime.agentLoopV2?.model, null),
      qualityModel: withDefault(agentRuntime.agentLoopV2?.qualityModel, null),
    },
  }
  const runtimeMode = resolveRuntimeMode(
    configuredRuntimeMode,
    sandboxConfig,
    agentRuntimeConfig
  )

  return {
    runtimeMode,
    configuredRuntimeMode,
    sandboxEnabled: runtimeMode === 'sandbox-v0',
    agentLoopV2Enabled: runtimeMode === 'agent-loop-v2',
    sandbox: sandboxConfig,
    agentRuntime: agentRuntimeConfig,
    agentContext,
  }
}

export function getAgentRuntimeStatus(currentSettings = settings) {
  const config = getAgentRuntimeConfig(currentSettings)
  const missingDependencies = []

  if (
    (config.sandboxEnabled || config.agentLoopV2Enabled) &&
    !config.sandbox.provider
  ) {
    missingDependencies.push('sandbox.provider')
  }
  if (
    (config.sandboxEnabled || config.agentLoopV2Enabled) &&
    (!config.sandbox.provider || config.sandbox.provider === 'local-docker') &&
    !config.sandbox.image
  ) {
    missingDependencies.push('sandbox.image')
  }
  if (
    (config.sandboxEnabled || config.agentLoopV2Enabled) &&
    config.sandbox.provider === 'e2b' &&
    !config.sandbox.e2bApiKey
  ) {
    missingDependencies.push('sandbox.e2bApiKey')
  }
  if (config.sandboxEnabled && !config.agentRuntime.adapter) {
    missingDependencies.push('agentRuntime.adapter')
  }
  if (config.sandboxEnabled && !config.agentRuntime.executable) {
    missingDependencies.push('agentRuntime.executable')
  }
  if (
    config.agentLoopV2Enabled &&
    !config.agentRuntime.agentLoopV2.apiBase
  ) {
    missingDependencies.push('agentRuntime.agentLoopV2.apiBase')
  }
  if (config.agentLoopV2Enabled && !config.agentRuntime.agentLoopV2.model) {
    missingDependencies.push('agentRuntime.agentLoopV2.model')
  }

  return {
    status: 'ok',
    runtimeMode: config.runtimeMode,
    configuredRuntimeMode: config.configuredRuntimeMode,
    sandboxEnabled: false,
    sandboxResearchEnabled: config.sandboxEnabled,
    agentLoopV2Enabled: config.agentLoopV2Enabled,
    sandboxProvider: config.sandboxEnabled ? config.sandbox.provider : null,
    runtimeAdapter: config.sandboxEnabled ? config.agentRuntime.adapter : null,
    model:
      config.runtimeMode === 'agent-loop-v2'
        ? config.agentRuntime.agentLoopV2.model
        : config.agentRuntime.model,
    apiBase:
      config.runtimeMode === 'agent-loop-v2'
        ? sanitizeApiBase(config.agentRuntime.agentLoopV2.apiBase)
        : null,
    defaultProfile: config.agentRuntime.defaultProfile,
    agentContext: config.agentContext,
    networkPolicy: config.sandbox.networkPolicy,
    sandboxCapabilities: resolveSandboxProviderCapabilities(
      config.sandbox.provider
    ),
    sandboxLimits: {
      workspaceTtlMs: config.sandbox.workspaceTtlMs,
      commandTimeoutMs: config.sandbox.commandTimeoutMs,
      maxOutputBytes: config.sandbox.maxOutputBytes,
      maxArtifactBytes: config.sandbox.maxArtifactBytes,
      maxFileCount: config.sandbox.maxFileCount,
      memoryBytes: config.sandbox.memoryBytes,
      memorySwapBytes: config.sandbox.memorySwapBytes,
      cpuCount: config.sandbox.cpuCount,
      pidsLimit: config.sandbox.pidsLimit,
    },
    cleanup: {
      startupCleanup:
        config.sandbox.provider === 'local-docker' &&
        (config.sandboxEnabled || config.agentLoopV2Enabled),
      manualCleanup:
        config.sandbox.provider === 'local-docker' &&
        (config.sandboxEnabled || config.agentLoopV2Enabled),
      workspaceTtlMs: config.sandbox.workspaceTtlMs,
    },
    missingDependencies,
  }
}

let initializedPromise = null
let fallbackRefreshTimer = null

async function refreshRuntimeSettings() {
  manager.invalidateCache()
  await manager.applyResolvedSettings(settings)
}

function stopFallbackRefreshLoop() {
  if (fallbackRefreshTimer) {
    clearInterval(fallbackRefreshTimer)
    fallbackRefreshTimer = null
  }
}

function startFallbackRefreshLoop() {
  stopFallbackRefreshLoop()
  const intervalMs =
    settings.runtimeConfig?.fallbackRefreshIntervalMs ??
    settings.runtimeConfig?.cacheTtlMs ??
    30000

  fallbackRefreshTimer = setInterval(() => {
    refreshRuntimeSettings().catch((err) => {
      logger.warn(
        { err },
        'failed to refresh ai runtime config from fallback loop'
      )
    })
  }, intervalMs)
  fallbackRefreshTimer.unref?.()
}

export async function initializeRuntimeConfig() {
  if (!initializedPromise) {
    initializedPromise = (async () => {
      await manager.ensureIndexes()
      await refreshRuntimeSettings()
      manager.on('updated', () => {
        refreshRuntimeSettings().catch((err) => {
          logger.warn({ err }, 'failed to refresh ai runtime config')
        })
      })
      if (manager.redisConfig) {
        try {
          await manager.start()
          stopFallbackRefreshLoop()
        } catch (err) {
          logger.warn(
            { err },
            'runtime config pubsub unavailable for ai-writing-agent, enabling fallback refresh loop'
          )
          startFallbackRefreshLoop()
        }
      } else {
        logger.warn(
          'runtime config pubsub is not configured for ai-writing-agent, enabling fallback refresh loop'
        )
        startFallbackRefreshLoop()
      }
      return manager
    })()
  }

  return initializedPromise
}

export async function shutdownRuntimeConfig() {
  stopFallbackRefreshLoop()
  await manager.stop()
}

export function getRuntimeConfigManager() {
  return manager
}
