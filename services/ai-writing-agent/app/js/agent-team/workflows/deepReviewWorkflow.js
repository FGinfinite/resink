const REVIEWER_CAPABILITIES = Object.freeze([
  'content-reviewer',
  'experiment-reviewer',
  'quality-checker',
])

export function createDeepReviewGraph(input = {}) {
  const userRequest = normalizeString(input.userRequest) || 'Deep review this paper.'
  const files = Array.isArray(input.files) ? input.files : []
  const baseInput = {
    userRequest,
    files,
    targetVenue: normalizeString(input.targetVenue) || null,
  }

  return {
    id: 'deep-review',
    workflowType: 'deep-review',
    nodes: [
      {
        id: 'reviewers',
        kind: 'parallel',
        nodes: REVIEWER_CAPABILITIES.map(capabilityName => ({
          id: capabilityName,
          kind: 'agent-task',
          taskSpec: {
            capabilityName,
            mode: 'workflow-node',
            objective: buildReviewerObjective(capabilityName),
            acceptanceCriteria: [
              'Return concrete findings only when supported by paper evidence.',
              'Include evidence references for each major or critical issue.',
              'Separate critical, major, minor, and question-style findings.',
            ],
            input: baseInput,
            outputSchema: { type: 'object' },
            contextPolicy: {
              includeParentHistory: false,
              includeProjectInstructions: true,
              includeSessionSummary: true,
              includeRecalledContext: true,
              includeActiveChangeSet: true,
              maxContextTokens: 12000,
            },
            policy: {
              tools: ['read_document', 'list_files', 'search_project'],
            },
          },
        })),
      },
      {
        id: 'reducer',
        kind: 'reducer',
        dependsOn: ['reviewers'],
        taskSpec: {
          capabilityName: 'deep-review-reducer',
          mode: 'reducer',
          objective:
            'Merge all Deep Review reviewer outputs into one deduplicated report with severity grouping and revision priorities.',
          acceptanceCriteria: [
            'Deduplicate overlapping findings across reviewers.',
            'Preserve reviewer evidence references.',
            'Include degraded-run notes for failed reviewer nodes.',
          ],
          input: baseInput,
          outputSchema: { type: 'object' },
          contextPolicy: { maxContextTokens: 12000 },
          policy: { tools: ['read_document'] },
        },
      },
      {
        id: 'critic',
        kind: 'critic',
        dependsOn: ['reducer'],
        taskSpec: {
          capabilityName: 'deep-review-critic',
          mode: 'critic',
          objective:
            'Validate the reduced Deep Review report for evidence quality, calibration, and omitted major risks.',
          acceptanceCriteria: [
            'Identify unsupported or over-severe findings.',
            'Check that the overall assessment is calibrated to the evidence.',
            'Return final validation notes for the user-facing report.',
          ],
          input: baseInput,
          outputSchema: { type: 'object' },
          contextPolicy: { maxContextTokens: 8000 },
          policy: { tools: ['read_document'] },
        },
      },
    ],
  }
}

function buildReviewerObjective(capabilityName) {
  if (capabilityName === 'content-reviewer') {
    return 'Review novelty, method soundness, claim-evidence alignment, and related work positioning.'
  }
  if (capabilityName === 'experiment-reviewer') {
    return 'Review experimental design, baselines, ablations, metrics, and statistical rigor.'
  }
  return 'Review writing clarity, LaTeX quality, citation/reference consistency, table-text consistency, and typos.'
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

export default createDeepReviewGraph
