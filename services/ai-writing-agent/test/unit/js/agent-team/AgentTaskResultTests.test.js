import { describe, expect, it } from 'vitest'

const {
  AgentTaskResultError,
  normalizeAgentTaskResult,
} = await import('../../../../app/js/agent-team/AgentTaskResult.js')

describe('AgentTaskResult', () => {
  it('normalizes structured findings with evidence refs', () => {
    const result = normalizeAgentTaskResult({
      status: 'completed',
      summary: 'Two issues found.',
      findings: [
        {
          severity: 'major',
          category: 'evidence',
          title: 'Unsupported central claim',
          description: 'The main claim lacks an experiment.',
          evidenceRefs: [
            { path: 'main.tex', locator: 'Section 3', quote: 'we show' },
          ],
          suggestedFix: 'Add supporting evidence or narrow the claim.',
          confidence: 0.8,
          sourceTaskIds: ['task-1', 'task-2'],
          sourceAgents: ['content-reviewer'],
        },
      ],
      proposedEdits: [],
      artifacts: [],
      confidence: 0.75,
      nextActions: [{ title: 'Revise claim', priority: 'high' }],
    })

    expect(result).toMatchObject({
      status: 'completed',
      summary: 'Two issues found.',
      findings: [
        {
          severity: 'major',
          category: 'evidence',
          title: 'Unsupported central claim',
          evidenceRefs: [
            { path: 'main.tex', locator: 'Section 3', quote: 'we show' },
          ],
          confidence: 0.8,
          duplicateOf: null,
          sourceTaskIds: ['task-1', 'task-2'],
          sourceAgents: ['content-reviewer'],
        },
      ],
      confidence: 0.75,
    })
  })

  it('rejects major and critical findings without evidence refs', () => {
    expect(() => normalizeAgentTaskResult({
      status: 'completed',
      summary: 'Issue found.',
      findings: [
        {
          severity: 'critical',
          category: 'method',
          title: 'Broken method',
          description: 'The method is unsupported.',
          evidenceRefs: [],
        },
      ],
    })).toThrow(AgentTaskResultError)
  })

  it('rejects malformed result fields before reducer consumption', () => {
    expect(() => normalizeAgentTaskResult({
      status: 'completed',
      summary: '',
      findings: [
        {
          severity: 'huge',
          title: 'Bad finding',
        },
      ],
    })).toThrow(AgentTaskResultError)
  })

  it('drops unsupported fields from findings and evidence refs', () => {
    const result = normalizeAgentTaskResult({
      status: 'completed',
      summary: 'One issue.',
      findings: [
        {
          severity: 'minor',
          category: 'clarity',
          title: 'Ambiguous notation',
          description: 'Notation changes names.',
          evidenceRefs: [
            {
              path: 'main.tex',
              locator: 'Equation 2',
              token: 'secret-value',
            },
          ],
          hiddenPrompt: 'do not store',
        },
      ],
    })

    expect(result.findings[0]).not.toHaveProperty('hiddenPrompt')
    expect(result.findings[0].evidenceRefs[0]).not.toHaveProperty('token')
  })
})
