import { describe, expect, it } from 'vitest'

const { AgentContextPackBuilder } = await import(
  '../../../../app/js/agent-team/AgentContextPackBuilder.js'
)

describe('AgentContextPackBuilder', () => {
  it('builds scoped context packs without copying full parent history', async () => {
    const builder = new AgentContextPackBuilder()

    const contextPack = await builder.build({
      teamId: 'team-1',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      activeChangeSetId: 'change-set-1',
      userRequest: 'Please run a deep review. apiKey=secret-value',
      parentHistorySummary: 'User asked for a deep review.',
      parentMessages: [
        { role: 'user', content: 'full private conversation should not be copied' },
      ],
      projectInstructions: {
        content: 'Use evidence-first review.',
        path: 'AGENTS.md',
        docId: 'doc-instructions',
      },
      memories: [
        {
          id: 'memory-1',
          content: 'User prefers concise findings.',
          scope: 'project',
          source: 'manual',
        },
        {
          id: 'memory-2',
          content: 'apiKey=secret-value',
          scope: 'global',
          source: 'manual',
        },
      ],
      sessionSummary: {
        id: 'summary-1',
        summary: 'The parent discussed methodology concerns.',
        sourceMessageRange: { fromSeq: 1, toSeq: 4 },
      },
      recalledContext: [
        {
          id: 'recall-1',
          type: 'summary',
          content: 'Prior summary says check baselines.',
          sourceRef: 'summary-1',
        },
      ],
      files: [
        {
          path: 'main.tex',
          mode: 'excerpt',
          content: 'This is the selected excerpt.',
          reason: 'Primary TeX file requested by task',
        },
      ],
      artifacts: [{ id: 'artifact-1', kind: 'compile-log' }],
      priorFindings: [{ title: 'Prior issue' }],
      diagnostics: {
        public: ['compile failed'],
        hiddenPrompt: 'do not leak',
        token: 'secret-token',
      },
      tokenBudget: 12000,
      contextPolicy: {
        includeParentHistory: false,
        includeProjectInstructions: true,
        includeMemories: true,
        includeSessionSummary: true,
        includeRecalledContext: true,
        includeDiagnostics: true,
        maxFileChars: 64,
      },
    })

    expect(contextPack).toMatchObject({
      teamId: 'team-1',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      activeChangeSetId: 'change-set-1',
      userRequestSummary: 'Please run a deep review. [REDACTED]',
      parentHistorySummary: null,
      projectInstructions: {
        content: 'Use evidence-first review.',
        path: 'AGENTS.md',
        refId: 'doc-instructions',
        tokenEstimate: 7,
      },
      memories: [
        {
          id: 'memory-1',
          content: 'User prefers concise findings.',
          scope: 'project',
          source: 'manual',
          tokenEstimate: 8,
        },
        {
          id: 'memory-2',
          content: '[REDACTED]',
          scope: 'global',
          source: 'manual',
          tokenEstimate: 3,
        },
      ],
      sessionSummary: {
        id: 'summary-1',
        summary: 'The parent discussed methodology concerns.',
        sourceMessageRange: { fromSeq: 1, toSeq: 4 },
        tokenEstimate: 11,
      },
      recalledContext: [
        {
          id: 'recall-1',
          type: 'summary',
          content: 'Prior summary says check baselines.',
          sourceRef: 'summary-1',
          tokenEstimate: 9,
        },
      ],
      files: [
        {
          path: 'main.tex',
          mode: 'excerpt',
          content: 'This is the selected excerpt.',
          reason: 'Primary TeX file requested by task',
        },
      ],
      artifacts: [{ id: 'artifact-1', kind: 'compile-log' }],
      priorFindings: [{ title: 'Prior issue' }],
      diagnostics: { public: ['compile failed'] },
      tokenBudget: 12000,
      sourceCounts: {
        projectInstructions: 1,
        memories: 2,
        sessionSummary: 1,
        recalledContext: 1,
        files: 1,
      },
    })
    expect(Reflect.get(contextPack, 'project' + 'Rules')).toBeUndefined()
    expect(contextPack.parentMessages).toBeUndefined()
    expect(JSON.stringify(contextPack)).not.toContain('secret-value')
    expect(JSON.stringify(contextPack)).not.toContain('secret-token')
    expect(JSON.stringify(contextPack)).not.toContain('do not leak')
    expect(contextPack.files[0].tokenEstimate).toBeGreaterThan(0)
  })

  it('omits instructions and memories unless context policy selects them', async () => {
    const builder = new AgentContextPackBuilder()

    const contextPack = await builder.build({
      teamId: 'team-1',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      projectInstructions: {
        content: 'Do not include by default.',
        path: 'AGENTS.md',
      },
      memories: [
        { id: 'memory-1', content: 'Do not include by default.', scope: 'project' },
      ],
      contextPolicy: {
        includeProjectInstructions: false,
        includeMemories: false,
      },
    })

    expect(contextPack.projectInstructions).toBeNull()
    expect(contextPack.memories).toEqual([])
    expect(contextPack.sourceCounts).toMatchObject({
      projectInstructions: 0,
      memories: 0,
    })
  })

  it('enforces file context budget and path safety', async () => {
    const builder = new AgentContextPackBuilder()

    const error = await captureError(builder.build({
      teamId: 'team-1',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      files: [
        {
          path: '../secret.tex',
          mode: 'full',
          content: 'secret',
          reason: 'unsafe',
        },
      ],
      tokenBudget: 1000,
    }))
    expect(error.message).toContain('Unsafe context file path')

    const contextPack = await builder.build({
      teamId: 'team-1',
      taskId: 'task-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      files: [
        {
          path: 'main.tex',
          mode: 'full',
          content: 'a'.repeat(200),
          reason: 'primary file',
        },
      ],
      tokenBudget: 1000,
      contextPolicy: { maxFileChars: 20 },
    })

    expect(contextPack.files[0].content).toBe(`${'a'.repeat(20)}\n[truncated]`)
  })
})

async function captureError(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected promise to reject')
}
