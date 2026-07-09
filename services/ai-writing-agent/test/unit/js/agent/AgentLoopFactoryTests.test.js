import { describe, expect, it, vi } from 'vitest'

vi.mock('@overleaf/settings', () => ({
  default: {
    agent: {},
    aiAssistant: {},
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
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const { AgentLoopV2 } = await import('../../../../app/js/agent/AgentLoopV2.js')
const {
  createAgentLoopForSession,
  resolveAgentLoopRuntime,
} = await import('../../../../app/js/agent/AgentLoopFactory.js')

function loopOptions(overrides = {}) {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    llmAdapter: {},
    toolRegistry: {},
    contextManager: {},
    adapters: { disablePersistence: true },
    ...overrides,
  }
}

describe('AgentLoopFactory', () => {
  it('uses AgentLoopV2 for agent-loop-v2 sessions', () => {
    const loop = createAgentLoopForSession(
      { runtimeMode: 'agent-loop-v2' },
      loopOptions()
    )

    expect(loop).toBeInstanceOf(AgentLoopV2)
    expect(loop.runtimeMode).toBe('agent-loop-v2')
    expect(loop.agentLoopPath).toBe('agent-loop-v2')
    expect(loop.runtimeVersion).toBe('v2')
  })

  it('uses AgentLoopV2 for explicit legacy rollback session records', () => {
    const loop = createAgentLoopForSession(
      { runtimeMode: 'legacy' },
      loopOptions()
    )

    expect(loop).toBeInstanceOf(AgentLoopV2)
    expect(loop.runtimeMode).toBe('agent-loop-v2')
    expect(loop.agentLoopPath).toBe('agent-loop-v2')
  })

  it('treats non-v2 runtime modes as AgentLoopV2 product compatibility', () => {
    expect(resolveAgentLoopRuntime({ runtimeMode: 'sandbox-v0' })).toBe(
      'agent-loop-v2'
    )
    expect(resolveAgentLoopRuntime({})).toBe('agent-loop-v2')
  })
})
