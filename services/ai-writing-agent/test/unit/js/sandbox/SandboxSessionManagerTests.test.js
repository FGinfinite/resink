import { describe, expect, it, vi } from 'vitest'
import {
  SandboxSessionDisabledError,
  SandboxSessionManager,
} from '../../../../app/js/sandbox/SandboxSessionManager.js'

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

vi.mock('@overleaf/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('@overleaf/config-system', () => ({
  default: {
    ConfigManager: class {},
    definitionsByService: {},
  },
}))

const PROJECT_ID = '0123456789abcdef01234567'
const USER_ID = 'abcdef0123456789abcdef01'

async function collect(iterable) {
  const events = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

function sandboxConfig(overrides = {}) {
  return {
    runtimeMode: 'sandbox-v0',
    sandboxEnabled: true,
    sandbox: {
      provider: 'mock-provider',
      image: 'mock-image',
      commandTimeoutMs: 1000,
      maxOutputBytes: 1000,
    },
    agentRuntime: {
      adapter: 'mock-runtime',
      executable: 'mock-runtime',
      defaultProfile: 'paper-reviewer',
    },
    ...overrides,
  }
}

describe('SandboxSessionManager', () => {
  it('rejects session creation when sandbox runtime is disabled', async () => {
    const manager = new SandboxSessionManager({
      getRuntimeConfig: () => ({ sandboxEnabled: false }),
      sessionsCollection: null,
    })

    try {
      await collect(manager.startSession({ projectId: PROJECT_ID, userId: USER_ID }))
      expect.unreachable('Expected sandbox disabled error')
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxSessionDisabledError)
    }
  })

  it('orchestrates provider, exporter, runtime, and diff collector events', async () => {
    const insertOne = vi.fn().mockResolvedValue({})
    const updateOne = vi.fn().mockResolvedValue({})
    const sandboxSession = {
      id: 'provider-session-1',
      workspacePath: '/tmp/mock-workspace',
      collectArtifacts: vi
        .fn()
        .mockResolvedValue([
          { path: 'main.pdf', size: 12, content: Buffer.from('pdf') },
        ]),
    }
    const provider = {
      createSession: vi.fn().mockResolvedValue(sandboxSession),
      destroySession: vi.fn().mockResolvedValue(undefined),
    }
    const manifest = {
      files: [{ path: '/main.tex', workspacePath: 'main.tex' }],
    }
    const exporter = {
      exportProject: vi.fn().mockResolvedValue(manifest),
    }
    const runtime = {
      run: vi.fn(async function* () {
        yield { type: 'text', content: 'runtime output' }
      }),
    }
    const diff = {
      created: [],
      modified: [{ path: '/main.tex' }],
      deleted: [],
      binaryChanged: [],
      unifiedDiff: 'diff',
    }
    const diffCollector = {
      collect: vi.fn().mockResolvedValue(diff),
    }
    const pendingChanges = [{ id: 'change-1', type: 'edit', status: 'pending' }]
    const expectedPendingChanges = [
      {
        id: 'change-1',
        type: 'edit',
        status: 'pending',
        sandboxSessionId: 'session-1',
      },
    ]
    const patchConverter = {
      convert: vi.fn().mockReturnValue(pendingChanges),
    }
    const profileRegistry = {
      get: vi.fn().mockReturnValue({
        artifactGlobs: ['*.pdf'],
      }),
      buildPrompt: vi.fn().mockReturnValue('profile prompt\ninspect project'),
    }
    const manager = new SandboxSessionManager({
      getRuntimeConfig: () => sandboxConfig(),
      provider,
      exporter,
      runtime,
      diffCollector,
      patchConverter,
      profileRegistry,
      sessionsCollection: { insertOne, updateOne },
      generateSessionId: () => 'session-1',
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    })

    const events = await collect(
      manager.startSession({
        projectId: PROJECT_ID,
        userId: USER_ID,
        prompt: 'inspect project',
      })
    )

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'project_exported',
      'runtime_started',
      'runtime_event',
      'diff_collected',
      'done',
    ])
    expect(provider.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        projectId: PROJECT_ID,
        userId: USER_ID,
      })
    )
    expect(exporter.exportProject).toHaveBeenCalledWith(
      PROJECT_ID,
      '/tmp/mock-workspace',
      expect.objectContaining({ userId: USER_ID, sessionId: 'session-1' })
    )
    expect(runtime.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'profile prompt\ninspect project',
        sandboxSession,
        sessionId: 'session-1',
        profile: 'paper-reviewer',
      })
    )
    expect(diffCollector.collect).toHaveBeenCalledWith(
      '/tmp/mock-workspace',
      manifest
    )
    expect(patchConverter.convert).toHaveBeenCalledWith(diff, manifest, {
      projectId: PROJECT_ID,
    })
    expect(events[4]).toMatchObject({
      type: 'diff_collected',
      changeCount: 1,
      diff,
      pendingChanges: expectedPendingChanges,
      artifacts: [expect.objectContaining({ path: 'main.pdf', size: 12 })],
    })
    expect(sandboxSession.collectArtifacts).toHaveBeenCalledWith(['*.pdf'])
    expect(provider.destroySession).toHaveBeenCalledWith('provider-session-1')
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'session-1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          pendingChanges: expectedPendingChanges,
        }),
      })
    )
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'session-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'done' }),
      })
    )
  })

  it('stops an active sandbox session by destroying the provider session', async () => {
    const updateOne = vi.fn().mockResolvedValue({})
    const provider = {
      destroySession: vi.fn().mockResolvedValue(undefined),
    }
    const runtime = {
      stop: vi.fn().mockResolvedValue(undefined),
    }
    const activeSessions = new Map([
      [
        'session-1',
        {
          provider,
          runtime,
          providerSessionId: 'provider-session-1',
          userId: USER_ID,
        },
      ],
    ])
    const manager = new SandboxSessionManager({
      getRuntimeConfig: () => sandboxConfig(),
      sessionsCollection: { updateOne },
      activeSessions,
      now: () => new Date('2026-06-19T00:00:00.000Z'),
    })

    const result = await manager.stopSession('session-1', USER_ID)

    expect(result).toEqual({ stopped: true })
    expect(runtime.stop).toHaveBeenCalledWith('session-1')
    expect(provider.destroySession).toHaveBeenCalledWith('provider-session-1')
    expect(activeSessions.has('session-1')).toBe(false)
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'session-1' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'stopped' }),
      })
    )
  })

  it('redacts secrets from stored text artifacts while preserving binary artifacts', async () => {
    const insertMany = vi.fn().mockResolvedValue({})
    const manager = new SandboxSessionManager({
      getRuntimeConfig: () =>
        sandboxConfig({
          sandbox: {
            provider: 'mock-provider',
            image: 'mock-image',
            workspaceTtlMs: 1000,
          },
        }),
      artifactsCollection: { insertMany },
    })

    await manager.storeArtifacts('session-1', [
      {
        path: 'compile.log',
        size: 64,
        content: Buffer.from(
          'OPENAI_API_KEY=sk-secret-value Authorization: Bearer token-value {"apiKey":"json-secret"}'
        ),
      },
      {
        path: 'paper.pdf',
        size: 16,
        content: Buffer.from([0, 1, 2, 3]),
      },
    ])

    const docs = insertMany.mock.calls[0][0]
    expect(docs[0].content.toString('utf8')).toContain('[redacted]')
    expect(docs[0].content.toString('utf8')).not.toContain('sk-secret-value')
    expect(docs[0].content.toString('utf8')).not.toContain('Bearer token-value')
    expect(docs[0].content.toString('utf8')).not.toContain('json-secret')
    expect(docs[1].content).toEqual(Buffer.from([0, 1, 2, 3]))
  })
})
