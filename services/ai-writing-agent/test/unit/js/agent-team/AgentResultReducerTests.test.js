import { describe, expect, it } from 'vitest'

const {
  AgentResultReducer,
} = await import('../../../../app/js/agent-team/AgentResultReducer.js')

describe('AgentResultReducer', () => {
  it('deduplicates findings and preserves source evidence', () => {
    const reducer = new AgentResultReducer()

    const result = reducer.reduce({
      reviewerResults: [
        {
          taskId: 'task-1',
          agentName: 'content-reviewer',
          result: {
            summary: 'Content issues.',
            findings: [
              finding({
                title: 'Unsupported central claim',
                sourceTaskId: 'task-1',
              }),
            ],
          },
        },
        {
          taskId: 'task-2',
          agentName: 'quality-checker',
          result: {
            summary: 'Quality issues.',
            findings: [
              finding({
                title: 'Unsupported central claim',
                sourceTaskId: 'task-2',
                evidenceRefs: [{ path: 'main.tex', locator: 'Abstract' }],
              }),
            ],
          },
        },
      ],
    })

    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      title: 'Unsupported central claim',
      duplicateOf: null,
      sourceTaskIds: ['task-1', 'task-2'],
    })
    expect(result.findings[0].evidenceRefs).toHaveLength(2)
    expect(result.summary).toContain('1 unique findings')
  })

  it('marks malformed reviewer results as degraded evidence', () => {
    const reducer = new AgentResultReducer()

    const result = reducer.reduce({
      reviewerResults: [
        {
          taskId: 'task-1',
          agentName: 'content-reviewer',
          result: {
            summary: 'Bad result',
            findings: [{ severity: 'major', title: 'No evidence' }],
          },
        },
      ],
    })

    expect(result.status).toBe('completed')
    expect(result.unresolvedQuestions[0]).toContain('task-1')
    expect(result.findings).toHaveLength(0)
  })

  it('critic downgrades unsupported high severity findings', () => {
    const reducer = new AgentResultReducer()

    const critique = reducer.criticReview({
      summary: 'Reduced report.',
      findings: [
        finding({
          severity: 'major',
          title: 'Weakly supported issue',
          evidenceRefs: [{ path: 'main.tex' }],
        }),
      ],
    })

    expect(critique.findings[0]).toMatchObject({
      title: 'Weakly supported issue',
      severity: 'minor',
    })
    expect(critique.criticNotes[0]).toContain('downgraded')
  })

  it('renders a readable final report backed by structured findings', () => {
    const reducer = new AgentResultReducer()
    const report = reducer.renderFinalReport({
      summary: 'Reduced report.',
      findings: [
        finding({
          severity: 'major',
          category: 'evidence',
          title: 'Unsupported central claim',
        }),
      ],
      criticNotes: ['Evidence checked.'],
    })

    expect(report).toContain('# Deep Review Report')
    expect(report).toContain('## Major Issues')
    expect(report).toContain('Unsupported central claim')
    expect(report).toContain('Evidence checked.')
  })
})

function finding(overrides = {}) {
  return {
    severity: 'major',
    category: 'evidence',
    title: 'Unsupported central claim',
    description: 'The paper needs stronger evidence.',
    evidenceRefs: [{ path: 'main.tex', locator: 'Section 1' }],
    suggestedFix: 'Add evidence.',
    confidence: 0.8,
    duplicateOf: null,
    ...overrides,
  }
}
