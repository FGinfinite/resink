import { describe, expect, it, vi } from 'vitest'
import { runSandboxStartupCleanup } from '../../../../app/js/sandbox/SandboxStartupCleanup.js'

vi.mock('@overleaf/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@overleaf/settings', () => ({
  default: {
    mongo: { url: 'mongodb://127.0.0.1/test', options: {} },
  },
}))

vi.mock('@overleaf/metrics', () => ({
  default: { mongodb: { monitor: vi.fn() } },
}))

vi.mock('@overleaf/mongo-utils', () => ({
  ObjectId: class ObjectId {
    constructor(value) {
      this.value = value
    }
  },
  db: {},
  waitForDb: vi.fn(),
}))

vi.mock('mongodb', () => ({
  MongoClient: class MongoClient {
    db() {
      return { collection: vi.fn(() => ({})) }
    }
  },
}))

vi.mock('@overleaf/config-system', () => ({
  default: {
    ConfigManager: class {},
    definitionsByService: {},
  },
}))

function sandboxConfig(overrides = {}) {
  return {
    runtimeMode: 'sandbox-v0',
    sandboxEnabled: true,
    sandbox: {
      provider: 'local-docker',
      image: 'resink-ai-sandbox:dev',
      commandTimeoutMs: 120000,
      maxOutputBytes: 2000000,
      maxArtifactBytes: 50000000,
      maxFileCount: 5000,
      networkPolicy: 'deny',
      memoryBytes: 536870912,
      memorySwapBytes: 536870912,
      cpuCount: 1,
      pidsLimit: 256,
    },
    ...overrides,
  }
}

describe('runSandboxStartupCleanup', () => {
  it('skips cleanup when sandbox mode is disabled', async () => {
    const Provider = vi.fn()

    const result = await runSandboxStartupCleanup({
      getRuntimeConfig: () => ({ sandboxEnabled: false, sandbox: {} }),
      LocalDockerSandboxProvider: Provider,
    })

    expect(result).toEqual({
      skipped: true,
      reason: 'sandbox-disabled-or-non-local-provider',
    })
    expect(Provider).not.toHaveBeenCalled()
  })

  it('runs local Docker startup cleanup with configured limits', async () => {
    const startupCleanup = vi.fn().mockResolvedValue({
      removedContainers: ['old-container'],
      removedWorkspaces: ['/tmp/old-workspace'],
    })
    const Provider = vi.fn(function LocalDockerSandboxProvider() {
      return { startupCleanup }
    })
    const logger = { info: vi.fn() }

    const result = await runSandboxStartupCleanup({
      getRuntimeConfig: () => sandboxConfig(),
      LocalDockerSandboxProvider: Provider,
      logger,
    })

    expect(Provider).toHaveBeenCalledWith(
      expect.objectContaining({
        image: 'resink-ai-sandbox:dev',
        maxFileCount: 5000,
        networkPolicy: 'deny',
        memoryBytes: 536870912,
        cpuCount: 1,
        pidsLimit: 256,
      })
    )
    expect(startupCleanup).toHaveBeenCalled()
    expect(result).toMatchObject({
      skipped: false,
      removedContainers: ['old-container'],
      removedWorkspaces: ['/tmp/old-workspace'],
    })
    expect(logger.info).toHaveBeenCalledWith(
      { removedContainers: 1, removedWorkspaces: 1 },
      'sandbox startup cleanup complete'
    )
  })
})
