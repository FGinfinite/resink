const PROJECT_READ_TOOLS = [
  'list_files',
  'read_document',
  'search_project',
  'view_file',
  'doc_structure_map',
]

export const TOOLSETS = Object.freeze({
  'project-read': Object.freeze(PROJECT_READ_TOOLS),
  'project-write': Object.freeze(['edit_document', 'delete_file']),
  'workspace-sync': Object.freeze(['sync_workspace_changes']),
  exec: Object.freeze(['run_command', 'write_workspace_file']),
  compile: Object.freeze(['compile_latex']),
  review: Object.freeze(['label_ref_audit']),
  citation: Object.freeze(['bib_lookup', 'bib_manage']),
  subagent: Object.freeze(['start_agent_task', 'start_agent_team']),
  handoff: Object.freeze(['handoff_to_agent', 'return_from_handoff']),
  diagnostics: Object.freeze(['activate_skill', 'inspect_python_environment']),
  'skill-runtime': Object.freeze(['read_skill_reference', 'run_skill_script']),
  memory: Object.freeze(['propose_memory']),
})

export const PROFILE_TOOLSETS = Object.freeze({
  default: Object.freeze([
    'project-read',
    'project-write',
    'compile',
    'exec',
    'workspace-sync',
    'review',
    'citation',
    'subagent',
    'handoff',
    'diagnostics',
    'skill-runtime',
    'memory',
  ]),
  'paper-reviewer': Object.freeze([
    'project-read',
    'project-write',
    'compile',
    'exec',
    'workspace-sync',
    'review',
    'citation',
    'subagent',
    'handoff',
    'diagnostics',
    'skill-runtime',
    'memory',
  ]),
  'document-auditor': Object.freeze(['project-read', 'review']),
  'quality-checker': Object.freeze(['project-read', 'review']),
  'content-reviewer': Object.freeze(['project-read']),
  'experiment-reviewer': Object.freeze(['project-read']),
  'citation-assistant': Object.freeze(['project-read', 'citation']),
  'read-only': Object.freeze(['project-read', 'review', 'citation']),
})

const POLICY_TOOLSET_BY_FLAG = Object.freeze({
  allowWrite: 'project-write',
  allowSubagents: 'subagent',
  allowHandoff: 'handoff',
  allowDiagnostics: 'diagnostics',
  allowSkillRuntime: 'skill-runtime',
  allowCitation: 'citation',
  allowReview: 'review',
  allowCompile: 'compile',
  allowExec: 'exec',
  allowWorkspaceSync: 'workspace-sync',
  allowMemoryProposals: 'memory',
})

export class ToolsetPolicy {
  constructor(options = {}) {
    this.toolsets = options.toolsets || TOOLSETS
    this.profileToolsets = options.profileToolsets || PROFILE_TOOLSETS
    this.defaultProfile = options.defaultProfile || 'default'
  }

  resolve(input = {}) {
    const profile = this._normalizeProfile(input.profile)
    const requestedToolsets = this._normalizeToolsets(
      input.toolsets || input.requestedToolsets || this.profileToolsets[profile]
    )
    const policy = this._normalizePolicy(input.policy || input)

    const allowedToolsets = []
    const allowedTools = new Set()

    for (const toolset of requestedToolsets) {
      if (!this._isToolsetAllowedByPolicy(toolset, policy)) continue
      allowedToolsets.push(toolset)
      for (const toolName of this.toolsets[toolset] || []) {
        allowedTools.add(toolName)
      }
    }

    if (Array.isArray(input.allowedToolNames)) {
      const allowList = new Set(input.allowedToolNames)
      for (const toolName of Array.from(allowedTools)) {
        if (!allowList.has(toolName)) {
          allowedTools.delete(toolName)
        }
      }
    }

    if (Array.isArray(input.deniedToolNames)) {
      for (const toolName of input.deniedToolNames) {
        allowedTools.delete(toolName)
      }
    }

    return {
      profile,
      toolsets: allowedToolsets,
      tools: Array.from(allowedTools),
    }
  }

  _normalizeProfile(profile) {
    if (typeof profile === 'string') {
      const trimmed = profile.trim()
      if (trimmed && this.profileToolsets[trimmed]) return trimmed
    }
    return this.defaultProfile
  }

  _normalizeToolsets(toolsets) {
    const source = Array.isArray(toolsets)
      ? toolsets
      : this.profileToolsets[this.defaultProfile] || []
    const normalized = []
    const seen = new Set()
    for (const toolset of source) {
      if (typeof toolset !== 'string') continue
      const name = toolset.trim()
      if (!name || seen.has(name) || !this.toolsets[name]) continue
      seen.add(name)
      normalized.push(name)
    }
    return normalized
  }

  _normalizePolicy(policy) {
    return {
      allowWrite: policy.allowWrite !== false,
      allowSubagents: policy.allowSubagents !== false,
      allowHandoff: policy.allowHandoff !== false,
      allowDiagnostics: policy.allowDiagnostics !== false,
      allowSkillRuntime: policy.allowSkillRuntime !== false,
      allowCitation: policy.allowCitation !== false,
      allowReview: policy.allowReview !== false,
      allowCompile: policy.allowCompile !== false,
      allowExec: policy.allowExec !== false,
      allowWorkspaceSync: policy.allowWorkspaceSync !== false,
      allowMemoryProposals: policy.allowMemoryProposals !== false,
    }
  }

  _isToolsetAllowedByPolicy(toolset, policy) {
    for (const [flag, blockedToolset] of Object.entries(POLICY_TOOLSET_BY_FLAG)) {
      if (toolset === blockedToolset && policy[flag] === false) {
        return false
      }
    }
    return true
  }
}

export default ToolsetPolicy
