import { beforeEach, describe, expect, it, vi } from 'vitest'

const { AgentContextBuilder } = await import(
  '../../../../app/js/agent-context/AgentContextBuilder.js'
)

describe('AgentContextBuilder', () => {
  let projectInstructionService
  let memoryService
  let sessionSummaryService
  let contextRecallService
  let contextSnapshotService
  let builder

  beforeEach(() => {
    projectInstructionService = {
      getInstructions: vi.fn().mockResolvedValue({
        exists: true,
        path: 'AGENTS.md',
        docId: 'doc-agents',
        content: 'Use concise edits. <do not escape>',
      }),
    }
    memoryService = {
      listMemories: vi.fn().mockResolvedValue([
        {
          _id: 'memory-1',
          scope: 'global',
          content: 'Answer in Chinese.',
          status: 'active',
        },
        {
          _id: 'memory-2',
          scope: 'project',
          projectId: 'project-1',
          content: 'Use IEEE citations.',
          status: 'active',
        },
      ]),
    }
    sessionSummaryService = {
      findLatestSummary: vi.fn().mockResolvedValue({
        _id: 'summary-1',
        summary: 'Earlier: user asked for related work edits.',
        tokenEstimate: 11,
      }),
    }
    contextRecallService = {
      recall: vi.fn().mockResolvedValue({
        items: [],
        memories: [],
        summaries: [],
        sourceRefs: [],
      }),
    }
    contextSnapshotService = {
      createSnapshot: vi.fn().mockResolvedValue({ _id: 'snapshot-1' }),
    }
    builder = new AgentContextBuilder({
      projectInstructionService,
      memoryService,
      sessionSummaryService,
      contextRecallService,
      contextSnapshotService,
    })
  })

  it('builds fenced context from project instructions, memories, and summary', async () => {
    const result = await builder.build(input())

    expect(result.block).toContain('<agent_context>')
    expect(result.block).toContain('<project_instructions>')
    expect(result.block).toContain('Use concise edits. &lt;do not escape&gt;')
    expect(result.block).toContain('<user_memories>')
    expect(result.block).toContain('Answer in Chinese.')
    expect(result.block).toContain('Use IEEE citations.')
    expect(result.block).toContain('<session_summary>')
    expect(result.block).toContain('Earlier: user asked for related work edits.')
    expect(result.sourceRefs.map(ref => ref.type)).toEqual([
      'project-instructions',
      'memory',
      'memory',
      'session-summary',
    ])
    expect(contextSnapshotService.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        projectId: 'project-1',
        userId: 'user-1',
        turnId: 'turn-1',
        sourceRefs: expect.arrayContaining([
          expect.objectContaining({
            type: 'project-instructions',
            refId: 'doc-agents',
            path: 'AGENTS.md',
          }),
          expect.objectContaining({
            type: 'memory',
            refId: 'memory-1',
            scope: 'global',
          }),
          expect.objectContaining({
            type: 'session-summary',
            refId: 'summary-1',
          }),
        ]),
      })
    )
  })

  it('loads only current user memories through MemoryService scope filtering', async () => {
    await builder.build(input())

    expect(memoryService.listMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      scope: 'all',
    })
  })

  it('does not inject memories when recall is disabled', async () => {
    const result = await builder.build({
      ...input(),
      recallEnabled: false,
    })

    expect(memoryService.listMemories).not.toHaveBeenCalled()
    expect(result.block).not.toContain('<user_memories>')
    expect(result.sourceRefs.map(ref => ref.type)).toEqual([
      'project-instructions',
      'session-summary',
    ])
  })

  it('injects bounded context recall as reference data', async () => {
    contextRecallService.recall.mockResolvedValue({
      items: [
        {
          type: 'summary',
          refId: 'summary-recall',
          scope: 'session',
          content: 'Earlier discussion about citation style.',
        },
      ],
      memories: [],
      summaries: [{ _id: 'summary-recall' }],
      sourceRefs: [
        {
          type: 'session-summary',
          refId: 'summary-recall',
          scope: 'session',
          tokenEstimate: 9,
          included: true,
          reason: 'context recall',
        },
      ],
    })

    const result = await builder.build(input())

    expect(result.block).toContain('<context_recall>')
    expect(result.block).toContain('Earlier discussion about citation style.')
    expect(result.sourceRefs).toContainEqual(
      expect.objectContaining({
        type: 'recall',
        refId: 'summary-recall',
        included: true,
      })
    )
  })

  it('omits missing instructions and empty context without creating prompt text', async () => {
    projectInstructionService.getInstructions.mockResolvedValue({
      exists: false,
      content: '',
    })
    memoryService.listMemories.mockResolvedValue([])
    sessionSummaryService.findLatestSummary.mockResolvedValue(null)

    const result = await builder.build(input())

    expect(result.block).toBeNull()
    expect(result.sourceRefs).toEqual([])
    expect(contextSnapshotService.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRefs: [] })
    )
  })
})

function input() {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    userId: 'user-1',
    turnId: 'turn-1',
  }
}
