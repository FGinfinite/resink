import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ProposeMemoryTool } = await import(
  '../../../../app/js/tool/propose_memory.js'
)

describe('ProposeMemoryTool', () => {
  let suggestionService
  let tool

  beforeEach(() => {
    suggestionService = {
      createSuggestion: vi.fn().mockResolvedValue({
        _id: 'suggestion-1',
        proposedContent: 'Prefer concise answers.',
        scope: 'global',
        reason: 'User asked repeatedly.',
        expiresAt: new Date('2026-07-25T00:00:00.000Z'),
      }),
    }
    tool = new ProposeMemoryTool({ suggestionService })
  })

  it('creates a user-confirmed memory suggestion for root agents', async () => {
    const result = await tool.execute({
      proposedContent: 'Prefer concise answers.',
      scope: 'global',
      reason: 'User asked repeatedly.',
    }, context())

    expect(result.success).toBe(true)
    expect(suggestionService.createSuggestion).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: null,
      sessionId: 'session-1',
      messageId: null,
      proposedContent: 'Prefer concise answers.',
      scope: 'global',
      reason: 'User asked repeatedly.',
    })
    expect(result.data.suggestionId).toBe('suggestion-1')
  })

  it('requires project id for project-scoped suggestions', async () => {
    const result = await tool.execute({
      proposedContent: 'Use project style.',
      scope: 'project',
      reason: 'Project preference.',
    }, {
      ...context(),
      projectId: null,
    })

    expect(result.success).toBe(false)
    expect(result.data.code).toBe('MEMORY_PROPOSAL_PROJECT_REQUIRED')
    expect(suggestionService.createSuggestion).not.toHaveBeenCalled()
  })

  it('blocks child agents from proposing memories', async () => {
    const result = await tool.execute({
      proposedContent: 'Nested preference.',
      scope: 'global',
      reason: 'Nested.',
    }, {
      ...context(),
      currentDepth: 1,
    })

    expect(result.success).toBe(false)
    expect(result.data.code).toBe('MEMORY_PROPOSAL_POLICY_DENIED')
    expect(suggestionService.createSuggestion).not.toHaveBeenCalled()
  })
})

function context() {
  return {
    userId: 'user-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    messageId: null,
    currentDepth: 0,
  }
}
