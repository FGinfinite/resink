import { describe, expect, it, vi } from 'vitest'

const { HandoffToAgentTool, ReturnFromHandoffTool } = await import(
  '../../../../app/js/tool/handoff_tools.js'
)

describe('handoff tools', () => {
  it('starts a handoff through AgentHandoffManager', async () => {
    const manager = {
      handoffToAgent: vi.fn(async () => ({
        status: 'active',
        teamId: 'team-1',
        taskId: 'task-1',
        childSessionId: 'child-1',
        capabilityName: 'compile-fixer',
        allowedToolNames: ['read_document', 'compile_latex'],
      })),
    }
    const tool = new HandoffToAgentTool({ handoffManager: manager })

    const result = await tool.execute(
      {
        capabilityName: 'compile-fixer',
        objective: 'Fix compile error.',
      },
      {
        sessionId: 'session-1',
        rootSessionId: 'root-1',
        projectId: 'project-1',
        userId: 'user-1',
        allowedToolNames: ['read_document', 'compile_latex'],
      }
    )

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      status: 'active',
      capabilityName: 'compile-fixer',
    })
    expect(manager.handoffToAgent).toHaveBeenCalledWith(expect.objectContaining({
      capabilityName: 'compile-fixer',
      objective: 'Fix compile error.',
      parentPolicy: expect.objectContaining({
        tools: ['read_document', 'compile_latex'],
        allowHandoff: true,
      }),
    }))
  })

  it('returns from the active handoff', async () => {
    const manager = {
      returnFromHandoff: vi.fn(async () => ({
        status: 'returned',
        teamId: 'team-1',
        taskId: 'task-1',
        reason: 'completed',
      })),
    }
    const tool = new ReturnFromHandoffTool({ handoffManager: manager })

    const result = await tool.execute(
      {
        teamId: 'team-1',
        taskId: 'task-1',
        reason: 'completed',
        summary: 'Done.',
      },
      {
        sessionId: 'session-1',
        rootSessionId: 'root-1',
        projectId: 'project-1',
        userId: 'user-1',
      }
    )

    expect(result.success).toBe(true)
    expect(result.data.status).toBe('returned')
    expect(manager.returnFromHandoff).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1',
      taskId: 'task-1',
      reason: 'completed',
      summary: 'Done.',
    }))
  })
})
