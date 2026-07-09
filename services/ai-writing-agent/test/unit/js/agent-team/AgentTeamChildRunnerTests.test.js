import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@overleaf/settings', () => ({
  default: {
    review: {},
  },
}))

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

const mockAgentLoop = { _agentLoop: vi.fn() }
const mockCreateAgentLoopForSession = vi.fn(() => mockAgentLoop)
vi.mock('../../../../app/js/agent/AgentLoopFactory.js', () => ({
  createAgentLoopForSession: mockCreateAgentLoopForSession,
}))

vi.mock('../../../../app/js/agent/ContextManager.js', () => ({
  ContextManager: vi.fn(),
}))

vi.mock('../../../../app/js/tool/ToolPool.js', () => ({
  buildToolRegistry: vi.fn(),
}))

const { AgentTeamChildRunner } = await import(
  '../../../../app/js/agent-team/AgentTeamChildRunner.js'
)

describe('AgentTeamChildRunner', () => {
  afterEach(() => {
    vi.useRealTimers()
    mockAgentLoop._agentLoop.mockReset()
    mockCreateAgentLoopForSession.mockClear()
  })

  it('filters recursive tools, runs child loop, and persists child turn', async () => {
    async function *childEvents() {
      yield { type: 'text', content: 'Child summary.' }
      yield { type: 'done', content: 'Child summary.', usage: { llmCalls: 1 } }
    }
    mockAgentLoop._agentLoop.mockImplementation(childEvents)
    const scopedRegistry = {
      getNames: () => ['read_document'],
      getTools: () => [{ type: 'function', function: { name: 'read_document' } }],
    }
    const parentToolRegistry = {
      scoped: vi.fn(() => scopedRegistry),
    }
    const agentMessageStore = {
      saveSimpleTurn: vi.fn(),
    }
    const agentController = {
      updateSessionStatus: vi.fn(),
    }
    const runner = new AgentTeamChildRunner({
      parentToolRegistry,
      agentController,
      promptLoader: {
        loadPrompt: vi.fn(async () => 'You are a child worker.'),
      },
    })

    const result = await runner.run({
      team: { _id: { toString: () => 'team-1' } },
      task: {
        _id: { toString: () => 'task-1' },
        objective: 'Review main.tex',
        acceptanceCriteria: ['Return findings'],
      },
      capability: {
        name: 'content-reviewer',
        defaultPolicy: { maxToolCalls: 4 },
      },
      contextPack: {
        teamId: 'team-1',
        taskId: 'task-1',
        activeChangeSetId: 'change-set-1',
        projectInstructions: {
          path: 'AGENTS.md',
          content: 'Use evidence-first review.',
        },
        memories: [
          {
            scope: 'project',
            content: 'Prefer concise findings.',
          },
        ],
        sessionSummary: {
          summary: 'Parent summary.',
        },
        recalledContext: [
          {
            type: 'memory',
            content: 'Recall selected note.',
          },
        ],
        files: [],
      },
      childSession: { _id: { toString: () => 'child-1' } },
      allowedToolNames: ['read_document', 'start_agent_task'],
      policy: {
        fileGlobs: ['**/*.tex'],
        writeGlobs: ['**/*.tex'],
        maxToolCalls: 4,
      },
      parentContext: {
        projectId: 'project-1',
        currentDocId: 'doc-1',
        currentDocPath: '/main.tex',
        userId: 'user-1',
        sessionId: 'parent-1',
        rootSessionId: 'root-1',
        adapters: { llm: {}, agentMessageStore },
        agentMessageStore,
        autoAccept: true,
        sessionState: { autoAccept: true },
      },
    })

    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Child summary.',
      usage: { llmCalls: 1 },
    })
    expect(parentToolRegistry.scoped).toHaveBeenCalledWith(['read_document'])
    expect(mockCreateAgentLoopForSession).toHaveBeenCalledWith(
      expect.objectContaining({ _id: expect.any(Object) }),
      expect.objectContaining({
        sessionId: 'child-1',
        toolRegistry: scopedRegistry,
        currentDocId: 'doc-1',
        currentDocPath: '/main.tex',
        rootSessionId: 'root-1',
        maxToolCalls: 4,
        agentTeam: {
          teamId: 'team-1',
          taskId: 'task-1',
          capabilityName: 'content-reviewer',
        },
        baseContext: {
          autoAccept: true,
          profile: undefined,
          agentName: 'content-reviewer',
          model: undefined,
          fileGlobs: ['**/*.tex'],
          writeGlobs: ['**/*.tex'],
          agentTeamPolicy: {
            fileGlobs: ['**/*.tex'],
            writeGlobs: ['**/*.tex'],
            maxToolCalls: 4,
          },
        },
      })
    )
    expect(mockAgentLoop._agentLoop).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({
        autoAccept: true,
      }),
      expect.any(Array)
    )
    const childMessages = mockAgentLoop._agentLoop.mock.calls[0][0]
    const childUserMessage = childMessages.find(message => message.role === 'user')
      .content
    expect(childUserMessage).toContain('Project instructions (AGENTS.md):')
    expect(childUserMessage).toContain('Use evidence-first review.')
    expect(childUserMessage).toContain('Selected user memories:')
    expect(childUserMessage).toContain('[project] Prefer concise findings.')
    expect(childUserMessage).toContain('Session summary:')
    expect(childUserMessage).toContain('Recalled context:')
    expect(childUserMessage).not.toContain('Legacy project configuration:')
    expect(agentMessageStore.saveSimpleTurn).toHaveBeenCalledWith(expect.objectContaining({
      userContent: 'Review main.tex',
      assistantContent: 'Child summary.',
    }))
    expect(agentController.updateSessionStatus).toHaveBeenCalledWith('child-1', 'completed')
  })

  it('passes a timeout-aware stop signal into the child loop', async () => {
    vi.useFakeTimers()
    let observedSignal
    async function *childEvents(_messages, _tools, _state, _history) {
      observedSignal = mockCreateAgentLoopForSession.mock.calls[0][1].stopSignal
      await new Promise(resolve => setTimeout(resolve, 25))
      yield { type: 'stopped' }
      yield { type: 'done', content: 'Stopped.' }
    }
    mockAgentLoop._agentLoop.mockImplementation(childEvents)
    const scopedRegistry = {
      getNames: () => ['read_document'],
      getTools: () => [{ type: 'function', function: { name: 'read_document' } }],
    }
    const runner = new AgentTeamChildRunner({
      parentToolRegistry: { scoped: vi.fn(() => scopedRegistry) },
      agentController: { updateSessionStatus: vi.fn() },
      promptLoader: {
        loadPrompt: vi.fn(async () => 'You are a child worker.'),
      },
    })

    const runPromise = runner.run({
      team: { _id: { toString: () => 'team-1' } },
      task: {
        _id: { toString: () => 'task-1' },
        objective: 'Review main.tex',
        acceptanceCriteria: ['Return findings'],
        timeoutMs: 10,
      },
      capability: {
        name: 'content-reviewer',
        defaultPolicy: { maxToolCalls: 4 },
      },
      contextPack: {
        teamId: 'team-1',
        taskId: 'task-1',
        files: [],
      },
      childSession: { _id: { toString: () => 'child-1' } },
      allowedToolNames: ['read_document'],
      policy: { maxToolCalls: 4 },
      parentContext: {
        projectId: 'project-1',
        userId: 'user-1',
        sessionId: 'parent-1',
        rootSessionId: 'root-1',
        adapters: { llm: {}, agentMessageStore: { saveSimpleTurn: vi.fn() } },
        agentMessageStore: { saveSimpleTurn: vi.fn() },
      },
    })

    await vi.advanceTimersByTimeAsync(15)
    expect(observedSignal).toBeDefined()
    expect(observedSignal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    const result = await runPromise
    expect(result).toMatchObject({
      status: 'timeout',
      summary: expect.stringContaining('timed out'),
    })
  })

  it('marks budget-limit fallback summaries as failed child tasks', async () => {
    async function *childEvents() {
      yield { type: 'text', content: '[已达到本次请求的 LLM 调用上限]' }
      yield {
        type: 'done',
        content: '[已达到本次请求的 LLM 调用上限]',
        usage: { llmCalls: 1 },
      }
    }
    mockAgentLoop._agentLoop.mockImplementation(childEvents)
    const scopedRegistry = {
      getNames: () => ['read_document'],
      getTools: () => [{ type: 'function', function: { name: 'read_document' } }],
    }
    const agentController = {
      updateSessionStatus: vi.fn(),
    }
    const runner = new AgentTeamChildRunner({
      parentToolRegistry: { scoped: vi.fn(() => scopedRegistry) },
      agentController,
      promptLoader: {
        loadPrompt: vi.fn(async () => 'You are a child worker.'),
      },
    })

    const result = await runner.run({
      team: { _id: { toString: () => 'team-1' } },
      task: {
        _id: { toString: () => 'task-1' },
        objective: 'Review main.tex',
        acceptanceCriteria: ['Return findings'],
      },
      capability: {
        name: 'content-reviewer',
        defaultPolicy: { maxToolCalls: 4 },
      },
      contextPack: {
        teamId: 'team-1',
        taskId: 'task-1',
        files: [],
      },
      childSession: { _id: { toString: () => 'child-1' } },
      allowedToolNames: ['read_document'],
      policy: { maxToolCalls: 4 },
      parentContext: {
        projectId: 'project-1',
        userId: 'user-1',
        sessionId: 'parent-1',
        rootSessionId: 'root-1',
        adapters: { llm: {}, agentMessageStore: { saveSimpleTurn: vi.fn() } },
        agentMessageStore: { saveSimpleTurn: vi.fn() },
      },
    })

    expect(result).toMatchObject({
      status: 'failed',
      summary: '[已达到本次请求的 LLM 调用上限]',
    })
    expect(result.events.map(event => event.type)).toContain('agent_task.budget_exhausted')
    expect(agentController.updateSessionStatus).toHaveBeenCalledWith('child-1', 'error')
  })
})
