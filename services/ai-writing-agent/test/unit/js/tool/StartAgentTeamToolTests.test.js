import { describe, expect, it, vi } from 'vitest'

const { StartAgentTeamTool } = await import(
  '../../../../app/js/tool/start_agent_team.js'
)

describe('StartAgentTeamTool', () => {
  it('starts the deep-review workflow through the orchestrator', async () => {
    const orchestrator = {
      startAgentTeam: vi.fn(async input => {
        await input.onTeamStarted?.({
          type: 'agent_team.started',
          teamId: 'team-1',
          workflowType: 'deep-review',
          mode: 'workflow-graph',
          status: 'running',
          sessionId: 'root-1',
        })
        return {
          teamId: 'team-1',
          workflowType: 'deep-review',
          status: 'completed',
          result: { summary: 'Deep review complete' },
        }
      }),
    }
    const tool = new StartAgentTeamTool({ orchestrator })

    const { events, result } = await collectToolExecution(tool.execute(
      {
        workflowType: 'deep-review',
        userRequest: 'Review this paper.',
        files: [{ path: 'main.tex', mode: 'excerpt', reason: 'main paper' }],
      },
      {
        sessionId: 'session-1',
        rootSessionId: 'root-1',
        projectId: 'project-1',
        userId: 'user-1',
        allowedToolNames: ['read_document', 'search_project'],
      }
    ))

    expect(events[0]).toMatchObject({
      type: 'agent_team.started',
      teamId: 'team-1',
      status: 'running',
    })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      teamId: 'team-1',
      workflowType: 'deep-review',
    })
    expect(orchestrator.startAgentTeam).toHaveBeenCalledWith(expect.objectContaining({
      workflowType: 'deep-review',
      sessionId: 'session-1',
      rootSessionId: 'root-1',
      projectId: 'project-1',
      userId: 'user-1',
      parentPolicy: expect.objectContaining({
        tools: ['read_document', 'search_project'],
      }),
    }))
  })

  it('fails closed when delegation budget is exhausted before starting a team', async () => {
    const orchestrator = {
      startAgentTeam: vi.fn(),
    }
    const runBudget = {
      tryConsumeDelegation: vi.fn(() => false),
      tryAcquireDelegationSlot: vi.fn(),
      releaseDelegationSlot: vi.fn(),
    }
    const tool = new StartAgentTeamTool({ orchestrator })

    const { result } = await collectToolExecution(tool.execute(
      {
        workflowType: 'deep-review',
        userRequest: 'Review this paper.',
      },
      {
        sessionId: 'session-1',
        rootSessionId: 'root-1',
        projectId: 'project-1',
        userId: 'user-1',
        allowedToolNames: ['read_document'],
        runBudget,
        currentDepth: 1,
      }
    ))

    expect(result.success).toBe(false)
    expect(result.output).toContain('delegation budget exhausted')
    expect(orchestrator.startAgentTeam).not.toHaveBeenCalled()
    expect(runBudget.tryConsumeDelegation).toHaveBeenCalledWith(1)
    expect(runBudget.tryAcquireDelegationSlot).not.toHaveBeenCalled()
    expect(runBudget.releaseDelegationSlot).not.toHaveBeenCalled()
  })

  it('releases the concurrent delegation slot after a team completes', async () => {
    const orchestrator = {
      startAgentTeam: vi.fn(async () => ({
        teamId: 'team-1',
        workflowType: 'deep-review',
        status: 'completed',
        result: { summary: 'Deep review complete' },
      })),
    }
    const runBudget = {
      tryConsumeDelegation: vi.fn(() => true),
      tryAcquireDelegationSlot: vi.fn(() => true),
      releaseDelegationSlot: vi.fn(),
    }
    const tool = new StartAgentTeamTool({ orchestrator })

    const { result } = await collectToolExecution(tool.execute(
      {
        workflowType: 'deep-review',
        userRequest: 'Review this paper.',
      },
      {
        sessionId: 'session-1',
        rootSessionId: 'root-1',
        projectId: 'project-1',
        userId: 'user-1',
        allowedToolNames: ['read_document'],
        runBudget,
        currentDepth: 0,
      }
    ))

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
