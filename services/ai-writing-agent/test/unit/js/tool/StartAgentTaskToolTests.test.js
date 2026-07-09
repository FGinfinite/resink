import { describe, expect, it, vi } from 'vitest'

const { StartAgentTaskTool } = await import(
  '../../../../app/js/tool/start_agent_task.js'
)

describe('StartAgentTaskTool', () => {
  it('runs a structured agent task through the team orchestrator', async () => {
    const orchestrator = {
      startAgentTask: vi.fn(async input => {
        await input.onTeamStarted?.({
          type: 'agent_team.started',
          teamId: 'team-1',
          workflowType: 'custom',
          mode: 'subagent-tool',
          status: 'running',
          sessionId: 'root-session',
        })
        return {
          teamId: 'team-1',
          taskId: 'task-1',
          childSessionId: 'child-1',
          status: 'completed',
          capabilityName: 'content-reviewer',
          allowedToolNames: ['read_document'],
          result: {
            summary: 'Structured child result',
            findings: [{ severity: 'major', title: 'Missing evidence' }],
          },
          events: [{ type: 'agent_task.completed' }],
        }
      }),
    }
    const tool = new StartAgentTaskTool({ orchestrator })

    const { events, result } = await collectToolExecution(tool.execute({
      capabilityName: 'content-reviewer',
      mode: 'tool',
      objective: 'Review claims.',
      acceptanceCriteria: ['Find evidence gaps'],
      input: { files: [] },
      outputSchema: { type: 'object' },
      policy: { tools: ['read_document'] },
      timeoutMs: 30000,
    }, {
      sessionId: 'parent-session',
      rootSessionId: 'root-session',
      projectId: 'project-1',
      userId: 'user-1',
      currentDocId: 'doc-1',
      currentDocPath: '/main.tex',
      profile: 'default',
      model: 'test-model',
      toolCallId: 'call-1',
      allowedToolNames: ['read_document', 'edit_document'],
      adapters: { llm: { chat: vi.fn() }, agentMessageStore: {} },
      confirmationChannel: { waitFor: vi.fn() },
      autoAccept: true,
      runBudget: { marker: 'budget' },
      sessionState: {
        activeChangeSet: { id: 'change-set-1' },
        activatedSkills: ['polish'],
      },
    }))

    expect(events[0]).toMatchObject({
      type: 'agent_team.started',
      teamId: 'team-1',
      status: 'running',
    })
    expect(result.success).toBe(true)
    expect(result.output).toContain('Agent task completed')
    expect(result.output).toContain('Structured child result')
    expect(result.data).toMatchObject({
      teamId: 'team-1',
      taskId: 'task-1',
      childSessionId: 'child-1',
      allowedToolNames: ['read_document'],
      events: [{ type: 'agent_task.completed' }],
    })
    expect(orchestrator.startAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'parent-session',
      projectId: 'project-1',
      userId: 'user-1',
      currentDocId: 'doc-1',
      currentDocPath: '/main.tex',
      profile: 'default',
      model: 'test-model',
      autoAccept: true,
      toolCallId: 'call-1',
      rootSessionId: 'root-session',
      activeChangeSetId: 'change-set-1',
      activatedSkillNames: ['polish'],
      taskSpec: expect.objectContaining({
        capabilityName: 'content-reviewer',
        objective: 'Review claims.',
      }),
      adapters: expect.objectContaining({
        llm: expect.any(Object),
      }),
      confirmationChannel: expect.any(Object),
      runBudget: { marker: 'budget' },
      parentPolicy: expect.objectContaining({
        tools: ['read_document', 'edit_document'],
      }),
    }))
    const input = orchestrator.startAgentTask.mock.calls[0][0]
    expect(input.parentPolicy).not.toHaveProperty('writeGlobs')
  })

  it('does not broaden parent write policy just because auto accept is enabled', async () => {
    const orchestrator = {
      startAgentTask: vi.fn(async () => ({
        teamId: 'team-1',
        taskId: 'task-1',
        childSessionId: 'child-1',
        status: 'completed',
        capabilityName: 'writing-editor',
        allowedToolNames: ['read_document', 'edit_document'],
        result: { summary: 'Edited.' },
        events: [],
      })),
    }
    const tool = new StartAgentTaskTool({ orchestrator })

    await collectToolExecution(tool.execute({
      capabilityName: 'writing-editor',
      mode: 'tool',
      objective: 'Edit main.tex.',
      acceptanceCriteria: ['Only edit tex files'],
      outputSchema: { type: 'object' },
      policy: {
        tools: ['read_document', 'edit_document'],
        writeGlobs: ['**/*.tex'],
      },
    }, {
      sessionId: 'parent-session',
      projectId: 'project-1',
      userId: 'user-1',
      allowedToolNames: ['read_document', 'edit_document'],
      autoAccept: true,
      adapters: { llm: { chat: vi.fn() }, agentMessageStore: {} },
      sessionState: {},
    }))

    expect(orchestrator.startAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      autoAccept: true,
      parentPolicy: expect.not.objectContaining({
        writeGlobs: expect.any(Array),
      }),
      taskSpec: expect.objectContaining({
        policy: expect.objectContaining({
          writeGlobs: ['**/*.tex'],
        }),
      }),
    }))
  })

  it('returns deterministic policy errors from the orchestrator', async () => {
    const error = new Error('Child agent policy has no usable permissions')
    error.code = 'AGENT_POLICY_DENIED'
    error.info = { reason: 'empty-child-policy' }
    const tool = new StartAgentTaskTool({
      orchestrator: {
        startAgentTask: vi.fn(async () => {
          throw error
        }),
      },
    })

    const { result } = await collectToolExecution(tool.execute({
      capabilityName: 'content-reviewer',
      mode: 'tool',
      objective: 'Review claims.',
      acceptanceCriteria: ['Find evidence gaps'],
      outputSchema: { type: 'object' },
      policy: { tools: ['run_command'] },
    }, {
      sessionId: 'parent-session',
      projectId: 'project-1',
      userId: 'user-1',
      allowedToolNames: ['read_document'],
    }))

    expect(result.success).toBe(false)
    expect(result.output).toContain('Agent task blocked')
    expect(result.data).toMatchObject({
      code: 'AGENT_POLICY_DENIED',
      reason: 'empty-child-policy',
    })
  })

  it('fails closed when delegation budget is exhausted before starting a task', async () => {
    const orchestrator = {
      startAgentTask: vi.fn(),
    }
    const runBudget = {
      tryConsumeDelegation: vi.fn(() => false),
      tryAcquireDelegationSlot: vi.fn(),
      releaseDelegationSlot: vi.fn(),
    }
    const tool = new StartAgentTaskTool({ orchestrator })

    const { result } = await collectToolExecution(tool.execute({
      capabilityName: 'content-reviewer',
      mode: 'tool',
      objective: 'Review claims.',
      acceptanceCriteria: ['Find evidence gaps'],
      outputSchema: { type: 'object' },
      policy: { tools: ['read_document'] },
    }, {
      sessionId: 'parent-session',
      projectId: 'project-1',
      userId: 'user-1',
      allowedToolNames: ['read_document'],
      runBudget,
      currentDepth: 1,
    }))

    expect(result.success).toBe(false)
    expect(result.output).toContain('delegation budget exhausted')
    expect(orchestrator.startAgentTask).not.toHaveBeenCalled()
    expect(runBudget.tryConsumeDelegation).toHaveBeenCalledWith(1)
    expect(runBudget.tryAcquireDelegationSlot).not.toHaveBeenCalled()
    expect(runBudget.releaseDelegationSlot).not.toHaveBeenCalled()
  })

  it('releases the concurrent delegation slot after a task completes', async () => {
    const orchestrator = {
      startAgentTask: vi.fn(async () => ({
        teamId: 'team-1',
        taskId: 'task-1',
        childSessionId: 'child-1',
        status: 'completed',
        capabilityName: 'content-reviewer',
        allowedToolNames: ['read_document'],
        result: { summary: 'done' },
        events: [],
      })),
    }
    const runBudget = {
      tryConsumeDelegation: vi.fn(() => true),
      tryAcquireDelegationSlot: vi.fn(() => true),
      releaseDelegationSlot: vi.fn(),
    }
    const tool = new StartAgentTaskTool({ orchestrator })

    const { result } = await collectToolExecution(tool.execute({
      capabilityName: 'content-reviewer',
      mode: 'tool',
      objective: 'Review claims.',
      acceptanceCriteria: ['Find evidence gaps'],
      outputSchema: { type: 'object' },
      policy: { tools: ['read_document'] },
    }, {
      sessionId: 'parent-session',
      projectId: 'project-1',
      userId: 'user-1',
      allowedToolNames: ['read_document'],
      runBudget,
      currentDepth: 0,
    }))

    expect(result.success).toBe(true)
    expect(runBudget.tryConsumeDelegation).toHaveBeenCalledWith(0)
    expect(runBudget.tryAcquireDelegationSlot).toHaveBeenCalled()
    expect(runBudget.releaseDelegationSlot).toHaveBeenCalled()
  })
})

async function collectToolExecution(generator) {
  const events = []
  let result = null
  for await (const item of generator) {
    if (item?._isToolResult) {
      result = item
    } else {
      events.push(item)
    }
  }
  return { events, result }
}
