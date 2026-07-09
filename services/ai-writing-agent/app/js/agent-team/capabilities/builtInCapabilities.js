import {
  CITATION_ASSISTANT_PROMPT,
  COMPILE_FIXER_PROMPT,
  CONTENT_REVIEWER_PROMPT,
  DOCUMENT_AUDITOR_PROMPT,
  EXPERIMENT_REVIEWER_PROMPT,
  GENERAL_AGENT_PROMPT,
  QUALITY_CHECKER_PROMPT,
  WRITING_EDITOR_PROMPT,
} from './builtInCapabilityPrompts.js'

const OBJECT_SCHEMA = Object.freeze({ type: 'object' })

const FINDING_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array' },
    proposedEdits: { type: 'array' },
    artifacts: { type: 'array' },
    confidence: { type: 'number' },
  },
})

export const BUILT_IN_AGENT_CAPABILITIES = Object.freeze([
  {
    ...workerCapability({
      name: 'general-agent',
      description:
        'General-purpose bounded worker for tasks that do not fit a specialist role, including calculation, command execution, small scripts, project inspection, and miscellaneous analysis.',
      prompt: GENERAL_AGENT_PROMPT,
      triggerHints: ['general task', 'calculate', 'command execution', 'script', 'miscellaneous analysis'],
      maxToolCalls: 8,
    }),
    defaultToolsets: ['project-read', 'exec', 'skill-runtime'],
    defaultPolicy: {
      tools: [
        'list_files',
        'read_document',
        'search_project',
        'run_command',
        'write_workspace_file',
        'read_skill_reference',
        'run_skill_script',
      ],
      fileGlobs: ['**/*'],
      writeGlobs: ['.agent/tmp/**', '.agent/scripts/**'],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 8,
      allowSpawn: false,
      allowHandoff: false,
    },
    contextPolicy: {
      includeParentHistory: true,
      includeProjectInstructions: true,
      includeMemories: false,
      includeSessionSummary: true,
      includeRecalledContext: true,
      includeActiveChangeSet: true,
      defaultFileMode: 'excerpt',
      maxContextTokens: 12000,
    },
  },
  workerCapability({
    name: 'content-reviewer',
    description:
      'Content review expert that evaluates novelty, methodological soundness, and claim-evidence alignment.',
    prompt: CONTENT_REVIEWER_PROMPT,
    triggerHints: ['deep review', 'novelty', 'methodology', 'claim evidence'],
    maxToolCalls: 24,
  }),
  workerCapability({
    name: 'experiment-reviewer',
    description:
      'Experiment review expert that evaluates experimental design, baseline completeness, ablation adequacy, and statistical rigor.',
    prompt: EXPERIMENT_REVIEWER_PROMPT,
    triggerHints: ['deep review', 'experiments', 'baselines', 'ablation'],
    maxToolCalls: 24,
  }),
  workerCapability({
    name: 'quality-checker',
    description:
      'Typesetting quality checker that inspects table-text consistency, symbol consistency, citations, typos, and LaTeX formatting.',
    prompt: QUALITY_CHECKER_PROMPT,
    triggerHints: ['deep review', 'quality check', 'formatting', 'citations'],
    maxToolCalls: 24,
  }),
  {
    ...workerCapability({
      name: 'deep-review-reducer',
      description:
        'Reducer that merges reviewer findings into a deduplicated Deep Review report.',
      prompt: CONTENT_REVIEWER_PROMPT,
      triggerHints: ['deep review reducer', 'merge findings'],
    }),
    role: 'reducer',
    defaultPolicy: {
      tools: ['read_document'],
      fileGlobs: ['**/*.tex', '**/*.bib'],
      writeGlobs: [],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 4,
      allowSpawn: false,
      allowHandoff: false,
    },
  },
  {
    ...workerCapability({
      name: 'deep-review-critic',
      description:
        'Critic that validates the Deep Review report for evidence, calibration, and missing major issues.',
      prompt: QUALITY_CHECKER_PROMPT,
      triggerHints: ['deep review critic', 'validate report'],
    }),
    role: 'critic',
    defaultPolicy: {
      tools: ['read_document'],
      fileGlobs: ['**/*.tex', '**/*.bib'],
      writeGlobs: [],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 4,
      allowSpawn: false,
      allowHandoff: false,
    },
  },
  {
    ...workerCapability({
      name: 'document-auditor',
      description:
        'Document structure auditor that analyzes section balance and cross-reference integrity.',
      prompt: DOCUMENT_AUDITOR_PROMPT,
      triggerHints: ['pre-submit', 'structure audit', 'cross references'],
    }),
    defaultToolsets: ['project-read', 'review'],
    defaultPolicy: {
      tools: [
        'read_document',
        'list_files',
        'search_project',
        'label_ref_audit',
        'doc_structure_map',
      ],
    },
  },
  {
    ...workerCapability({
      name: 'citation-assistant',
      description:
        'Citation management specialist that searches papers, validates and deduplicates BibTeX, and finds unused or missing references.',
      prompt: CITATION_ASSISTANT_PROMPT,
      triggerHints: ['citation audit', 'bibtex', 'references'],
    }),
    role: 'handoff-specialist',
    defaultToolsets: ['project-read', 'citation'],
    defaultPolicy: {
      tools: [
        'read_document',
        'list_files',
        'search_project',
        'bib_lookup',
        'bib_manage',
      ],
      allowHandoff: true,
    },
  },
  {
    ...workerCapability({
      name: 'compile-fixer',
      description:
        'LaTeX compile repair specialist that compiles the project, diagnoses errors, and proposes focused fixes.',
      prompt: COMPILE_FIXER_PROMPT,
      triggerHints: ['compile fix', 'latex error', 'build failure'],
    }),
    role: 'handoff-specialist',
    defaultToolsets: [
      'project-read',
      'compile',
      'project-write',
      'workspace-sync',
      'skill-runtime',
    ],
    defaultPolicy: {
      tools: [
        'list_files',
        'read_document',
        'compile_latex',
        'edit_document',
        'sync_workspace_changes',
        'read_skill_reference',
        'run_skill_script',
        'write_workspace_file',
      ],
      allowHandoff: true,
    },
  },
  {
    ...workerCapability({
      name: 'writing-editor',
      description:
        'Focused academic writing editor that performs bounded prose edits with explicit file scope.',
      prompt: WRITING_EDITOR_PROMPT,
      triggerHints: ['writing edit', 'polish', 'rewrite'],
    }),
    defaultToolsets: [
      'project-read',
      'project-write',
      'workspace-sync',
      'skill-runtime',
    ],
    defaultPolicy: {
      tools: [
        'read_document',
        'list_files',
        'search_project',
        'edit_document',
        'sync_workspace_changes',
        'read_skill_reference',
        'run_skill_script',
        'write_workspace_file',
      ],
    },
  },
])

function workerCapability({
  name,
  description,
  prompt,
  triggerHints,
  maxToolCalls = 8,
}) {
  return {
    name,
    version: '1.0.0',
    description,
    role: 'worker',
    triggerHints,
    inputSchema: OBJECT_SCHEMA,
    outputSchema: FINDING_RESULT_SCHEMA,
    defaultModelTier: 'standard',
    defaultToolsets: ['project-read'],
    defaultPolicy: {
      tools: ['read_document', 'list_files', 'search_project'],
      fileGlobs: ['**/*.tex', '**/*.bib'],
      writeGlobs: [],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls,
      allowSpawn: false,
      allowHandoff: false,
    },
    contextPolicy: {
      includeParentHistory: false,
      includeProjectInstructions: true,
      includeMemories: false,
      includeSessionSummary: true,
      includeRecalledContext: true,
      includeActiveChangeSet: true,
      defaultFileMode: 'excerpt',
      maxContextTokens: 12000,
    },
    promptRef: {
      kind: 'builtin-agent-prompt',
      prompt,
    },
    safety: {
      classification: 'standard',
      hiddenPrompt: true,
    },
  }
}

export default BUILT_IN_AGENT_CAPABILITIES
