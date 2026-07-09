import { describe, expect, it } from 'vitest'

const { AgentTaskSpecError, normalizeAgentTaskSpec } = await import(
  '../../../../app/js/agent-team/AgentTaskSpec.js'
)

describe('AgentTaskSpec', () => {
  it('normalizes a valid task spec with defaults', () => {
    const normalized = normalizeAgentTaskSpec({
      teamId: 'team-123',
      parentTaskId: 'task.parent_1',
      rootSessionId: 'session-abc',
      capabilityName: 'compile-fixer',
      capabilityVersion: '1.0.0',
      mode: 'tool',
      objective: 'Fix the current LaTeX compile error.',
      acceptanceCriteria: 'Compilation succeeds',
      input: { file: 'main.tex' },
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
      },
      contextPolicy: { includeParentHistory: false },
      policy: { tools: ['compile_latex'] },
      timeoutMs: 30000,
    })

    expect(normalized).toEqual({
      teamId: 'team-123',
      parentTaskId: 'task.parent_1',
      rootSessionId: 'session-abc',
      capabilityName: 'compile-fixer',
      capabilityVersion: '1.0.0',
      mode: 'tool',
      objective: 'Fix the current LaTeX compile error.',
      acceptanceCriteria: ['Compilation succeeds'],
      input: { file: 'main.tex' },
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
      },
      contextPolicy: { includeParentHistory: false },
      policy: { tools: ['compile_latex'] },
      dependencies: [],
      priority: 0,
      timeoutMs: 30000,
      retryPolicy: {
        maxAttempts: 1,
        backoffMs: 0,
      },
    })
  })

  it('normalizes acceptance criteria arrays and explicit scheduling fields', () => {
    const normalized = normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'critic',
      objective: 'Review introduction clarity.',
      acceptanceCriteria: [
        'Identify vague claims',
        ' ',
        'Suggest concrete edits',
        'Identify vague claims',
      ],
      outputSchema: { type: 'object' },
      dependencies: ['task-1', 'task_2'],
      priority: 4,
      timeoutMs: 1000,
      retryPolicy: {
        maxAttempts: 3,
        backoffMs: 250,
      },
    })

    expect(normalized.acceptanceCriteria).toEqual([
      'Identify vague claims',
      'Suggest concrete edits',
    ])
    expect(normalized.dependencies).toEqual(['task-1', 'task_2'])
    expect(normalized.priority).toBe(4)
    expect(normalized.retryPolicy).toEqual({
      maxAttempts: 3,
      backoffMs: 250,
    })
  })

  it('rejects invalid mode and capability names', () => {
    expect(() => normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'chat',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: { type: 'object' },
    })).toThrow(AgentTaskSpecError)

    expect(() => normalizeAgentTaskSpec({
      capabilityName: '../secret',
      mode: 'tool',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: { type: 'object' },
    })).toThrow(AgentTaskSpecError)
  })

  it('rejects non-object output schemas', () => {
    expect(() => normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'tool',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: { type: 'string' },
    })).toThrow(AgentTaskSpecError)

    expect(() => normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'tool',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: ['not-a-schema'],
    })).toThrow(AgentTaskSpecError)
  })

  it('rejects sensitive prompt and secret fields at any depth', () => {
    expect(() => normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'tool',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: { type: 'object' },
      systemPrompt: 'hidden instructions',
    })).toThrow(AgentTaskSpecError)

    expect(() => normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'tool',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: { type: 'object' },
      input: {
        apiKey: 'sk-test',
      },
    })).toThrow(AgentTaskSpecError)

    expect(() => normalizeAgentTaskSpec({
      capabilityName: 'writing-editor',
      mode: 'tool',
      objective: 'Do work.',
      acceptanceCriteria: ['Done'],
      outputSchema: { type: 'object' },
      input: {
        raw_secret: 'do not pass through',
      },
    })).toThrow(AgentTaskSpecError)
  })
})
