import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    log: vi.fn(),
  },
}))

vi.mock('@overleaf/settings', () => ({
  default: {
    redis: {},
    runtimeConfig: {},
    aiAssistant: {},
  },
}))

vi.mock('@overleaf/config-system', () => ({
  default: {
    ConfigManager: class {
      constructor(options) {
        this.redisConfig = options.redisConfig
      }

      invalidateCache() {}

      async applyResolvedSettings() {}

      async ensureIndexes() {}

      on() {}

      async start() {}

      async stop() {}
    },
    definitionsByService: {},
  },
}))

vi.mock('../../../app/js/mongodb.js', () => ({
  db: {
    appConfigValues: {},
    appConfigRevisions: {},
    appConfigAuditLogs: {},
  },
}))

describe('RuntimeConfigManager agent runtime config', () => {
  let module

  beforeEach(async () => {
    vi.resetModules()
    module = await import('../../../app/js/RuntimeConfigManager.js')
  })

  it('defaults to AgentLoopV2 product mode and reports missing dependencies', () => {
    const config = module.getAgentRuntimeConfig({})

    expect(config.runtimeMode).toBe('agent-loop-v2')
    expect(config.configuredRuntimeMode).toBe('agent-loop-v2')
    expect(config.sandboxEnabled).toBe(false)
    expect(config.agentLoopV2Enabled).toBe(true)
    expect(config.sandbox.provider).toBe('local-docker')
    expect(config.sandbox.image).toBe('resink-ai-sandbox:dev')
    expect(config.sandbox.dockerRootDir).toBe(null)
    expect(config.sandbox.maxFileCount).toBe(5000)
    expect(config.sandbox.memoryBytes).toBe(536870912)
    expect(config.sandbox.memorySwapBytes).toBe(536870912)
    expect(config.sandbox.cpuCount).toBe(1)
    expect(config.sandbox.pidsLimit).toBe(256)
    expect(config.agentRuntime.adapter).toBe('opencode')
    expect(config.agentRuntime.model).toBe(null)
    expect(config.agentRuntime.reasoningEffort).toBe(null)
    expect(config.agentRuntime.sandboxMode).toBe(null)
    expect(config.agentRuntime.defaultProfile).toBe('paper-reviewer')
    expect(config.agentRuntime.agentLoopV2).toEqual({
      enabled: true,
      apiBase: null,
      model: null,
      qualityModel: null,
    })
    expect(config.agentContext).toEqual({
      enabled: true,
      projectInstructionsFile: 'AGENTS.md',
      maxInstructionChars: 40000,
      maxMemoryChars: 2000,
      maxMemoriesPerTurn: 12,
      maxRecallChars: 6000,
      recallEnabled: true,
      suggestionTtlMs: 2592000000,
      blockSecretLookingContent: true,
      blockPromptInjectionLookingContent: true,
    })
  })

  it('reads agent context feature flag and bounds from settings', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        agentContext: {
          enabled: true,
          projectInstructionsFile: 'PROJECT.md',
          maxInstructionChars: 100,
          maxMemoryChars: 200,
          maxMemoriesPerTurn: 3,
          maxRecallChars: 500,
          recallEnabled: false,
          suggestionTtlMs: 12345,
          blockSecretLookingContent: false,
          blockPromptInjectionLookingContent: false,
        },
      },
    })

    expect(config.agentContext).toEqual({
      enabled: true,
      projectInstructionsFile: 'PROJECT.md',
      maxInstructionChars: 100,
      maxMemoryChars: 200,
      maxMemoriesPerTurn: 3,
      maxRecallChars: 500,
      recallEnabled: false,
      suggestionTtlMs: 12345,
      blockSecretLookingContent: false,
      blockPromptInjectionLookingContent: false,
    })
  })

  it('auto-enables AgentLoopV2 when first-party endpoint and model are configured', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'auto',
        agentRuntime: {
          agentLoopV2: {
            apiBase: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-flash',
            qualityModel: 'deepseek-v4-flash',
          },
        },
      },
    })

    expect(config.runtimeMode).toBe('agent-loop-v2')
    expect(config.configuredRuntimeMode).toBe('auto')
    expect(config.sandboxEnabled).toBe(false)
    expect(config.agentLoopV2Enabled).toBe(true)
    expect(config.agentRuntime.agentLoopV2).toMatchObject({
      enabled: true,
      apiBase: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      qualityModel: 'deepseek-v4-flash',
    })
  })

  it('does not auto-select sandbox-v0 when AgentLoopV2 is disabled', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'auto',
        sandbox: {
          provider: 'local-docker',
          image: 'resink-ai-sandbox:dev',
        },
        agentRuntime: {
          adapter: 'opencode',
          executable: 'opencode',
          agentLoopV2: {
            enabled: false,
            apiBase: 'https://api.deepseek.com/v1',
            model: 'deepseek-v4-flash',
          },
        },
      },
    })

    expect(config.runtimeMode).toBe('agent-loop-v2')
    expect(config.sandboxEnabled).toBe(false)
    expect(config.agentLoopV2Enabled).toBe(true)
  })

  it('does not treat sandbox-v0 adapter model configuration as AgentLoopV2 enablement', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'auto',
        agentRuntime: {
          adapter: 'codex',
          executable: 'codex',
          model: 'gpt-5.2-codex',
        },
      },
    })

    expect(config.runtimeMode).toBe('agent-loop-v2')
    expect(config.sandboxEnabled).toBe(false)
    expect(config.agentLoopV2Enabled).toBe(true)
  })

  it('does not auto-enable sandbox-v0 mode when CLI dependencies are configured', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'auto',
        sandbox: {
          provider: 'local-docker',
          image: 'resink-ai-sandbox:dev',
        },
        agentRuntime: {
          adapter: 'opencode',
          executable: 'opencode',
        },
      },
    })

    expect(config.runtimeMode).toBe('agent-loop-v2')
    expect(config.configuredRuntimeMode).toBe('auto')
    expect(config.sandboxEnabled).toBe(false)
    expect(config.agentLoopV2Enabled).toBe(true)
  })

  it('reads optional runtime adapter tuning fields', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'sandbox-v0',
        agentRuntime: {
          adapter: 'codex',
          executable: 'codex',
          model: 'gpt-test',
          reasoningEffort: 'high',
          sandboxMode: 'workspace-write',
        },
      },
    })

    expect(config.agentRuntime).toMatchObject({
      adapter: 'codex',
      executable: 'codex',
      model: 'gpt-test',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
    })
  })

  it('accepts the old sandbox runtime mode alias for rollback compatibility', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'sandbox',
      },
    })

    expect(config.runtimeMode).toBe('sandbox-v0')
    expect(config.configuredRuntimeMode).toBe('sandbox-v0')
    expect(config.sandboxEnabled).toBe(true)
  })

  it('defaults runtime sandbox network policy to deny', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        sandbox: {},
      },
    })

    expect(config.sandbox.networkPolicy).toBe('deny')
  })

  it('reports explicit sandbox-v0 as research-only, not user-enabled', () => {
    const status = module.getAgentRuntimeStatus({
      aiAssistant: {
        runtimeMode: 'sandbox-v0',
        sandbox: {
          provider: 'local-docker',
          image: 'resink-ai-sandbox:test',
          networkPolicy: 'test-deny',
        },
        agentRuntime: {
          adapter: 'opencode',
          executable: 'opencode',
          defaultProfile: 'compile-fixer',
        },
      },
    })

    expect(status).toEqual({
      status: 'ok',
      runtimeMode: 'sandbox-v0',
      configuredRuntimeMode: 'sandbox-v0',
      sandboxEnabled: false,
      sandboxResearchEnabled: true,
      agentLoopV2Enabled: false,
      sandboxProvider: 'local-docker',
      runtimeAdapter: 'opencode',
      model: null,
      apiBase: null,
      defaultProfile: 'compile-fixer',
      agentContext: {
        enabled: true,
        projectInstructionsFile: 'AGENTS.md',
        maxInstructionChars: 40000,
        maxMemoryChars: 2000,
        maxMemoriesPerTurn: 12,
        maxRecallChars: 6000,
        recallEnabled: true,
        suggestionTtlMs: 2592000000,
        blockSecretLookingContent: true,
        blockPromptInjectionLookingContent: true,
      },
      networkPolicy: 'test-deny',
      sandboxCapabilities: {
        immutableRuntimeEnvironmentMount: true,
      },
      sandboxLimits: {
        workspaceTtlMs: 86400000,
        commandTimeoutMs: 120000,
        maxOutputBytes: 2000000,
        maxArtifactBytes: 50000000,
        maxFileCount: 5000,
        memoryBytes: 536870912,
        memorySwapBytes: 536870912,
        cpuCount: 1,
        pidsLimit: 256,
      },
      cleanup: {
        startupCleanup: true,
        manualCleanup: true,
        workspaceTtlMs: 86400000,
      },
      missingDependencies: [],
    })
  })

  it('reports AgentLoopV2 status without exposing sandbox-v0 as enabled', () => {
    const status = module.getAgentRuntimeStatus({
      aiAssistant: {
        runtimeMode: 'agent-loop-v2',
        agentRuntime: {
          agentLoopV2: {
            enabled: true,
            apiBase:
              'https://sk-secret@example.deepseek.test/v1?api_key=leak',
            model: 'deepseek-v4-flash',
          },
        },
      },
    })

    expect(status).toMatchObject({
      status: 'ok',
      runtimeMode: 'agent-loop-v2',
      configuredRuntimeMode: 'agent-loop-v2',
      sandboxEnabled: false,
      agentLoopV2Enabled: true,
      model: 'deepseek-v4-flash',
      apiBase: 'https://example.deepseek.test/v1',
      agentContext: {
        enabled: true,
        projectInstructionsFile: 'AGENTS.md',
        maxInstructionChars: 40000,
        maxMemoryChars: 2000,
        maxMemoriesPerTurn: 12,
        maxRecallChars: 6000,
        recallEnabled: true,
        suggestionTtlMs: 2592000000,
        blockSecretLookingContent: true,
        blockPromptInjectionLookingContent: true,
      },
      sandboxCapabilities: {
        immutableRuntimeEnvironmentMount: true,
      },
      sandboxLimits: expect.objectContaining({
        commandTimeoutMs: 120000,
        maxOutputBytes: 2000000,
        maxArtifactBytes: 50000000,
        maxFileCount: 5000,
        memoryBytes: 536870912,
        cpuCount: 1,
        pidsLimit: 256,
      }),
      cleanup: {
        startupCleanup: true,
        manualCleanup: true,
        workspaceTtlMs: 86400000,
      },
      missingDependencies: [],
    })
    expect(JSON.stringify(status)).not.toContain('sk-secret')
    expect(JSON.stringify(status)).not.toContain('api_key')
  })

  it('reports missing AgentLoopV2 provider and model dependencies', () => {
    const status = module.getAgentRuntimeStatus({
      aiAssistant: {
        runtimeMode: 'agent-loop-v2',
        sandbox: {
          provider: 'e2b',
          e2bApiKey: '',
        },
        agentRuntime: {
          agentLoopV2: {
            enabled: true,
            apiBase: '',
            model: '',
          },
        },
      },
    })

    expect(status.missingDependencies).toEqual([
      'sandbox.e2bApiKey',
      'agentRuntime.agentLoopV2.apiBase',
      'agentRuntime.agentLoopV2.model',
    ])
    expect(status.cleanup).toEqual({
      startupCleanup: false,
      manualCleanup: false,
      workspaceTtlMs: 86400000,
    })
    expect(status.sandboxCapabilities).toEqual({
      immutableRuntimeEnvironmentMount: false,
    })
  })

  it('falls back to AgentLoopV2 for invalid runtime modes', () => {
    const config = module.getAgentRuntimeConfig({
      aiAssistant: {
        runtimeMode: 'unknown',
      },
    })

    expect(config.runtimeMode).toBe('agent-loop-v2')
    expect(config.configuredRuntimeMode).toBe('agent-loop-v2')
    expect(config.sandboxEnabled).toBe(false)
    expect(config.agentLoopV2Enabled).toBe(true)
  })

  it('reports missing sandbox dependencies only when sandbox mode is enabled', () => {
    const status = module.getAgentRuntimeStatus({
      aiAssistant: {
        runtimeMode: 'sandbox-v0',
        sandbox: {
          provider: '',
          image: '',
        },
        agentRuntime: {
          adapter: '',
          executable: '',
        },
      },
    })

    expect(status.missingDependencies).toEqual([
      'sandbox.provider',
      'sandbox.image',
      'agentRuntime.adapter',
      'agentRuntime.executable',
    ])
  })
})
