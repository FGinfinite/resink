/* eslint-disable no-console */
import { ToolRegistry } from './ToolRegistry.js'
import { ReadDocumentTool } from './read.js'
import { EditDocumentTool } from './edit.js'
import { DeleteFileTool } from './delete.js'
import { ListFilesTool } from './list.js'
import { SearchProjectTool } from './search.js'
import { BibLookupTool } from './bib_lookup.js'
import { DocStructureMapTool } from './doc_structure_map.js'
import { BibManageTool } from './bib_manage.js'
import { LabelRefAuditTool } from './label_ref_audit.js'
import { ViewFileTool } from './view-file.js'
import { CompileLatexTool } from './compile_latex.js'
import { SyncWorkspaceChangesTool } from './sync_workspace_changes.js'
import { RunCommandTool } from './run_command.js'
import { WriteWorkspaceFileTool } from './write_workspace_file.js'
import { InspectPythonEnvironmentTool } from './inspect_python_environment.js'
import { StartAgentTeamTool } from './start_agent_team.js'
import { HandoffToAgentTool, ReturnFromHandoffTool } from './handoff_tools.js'
import { ProposeMemoryTool } from './propose_memory.js'

const TOOL_FACTORIES = {
  read_document: () => new ReadDocumentTool(),
  edit_document: () => new EditDocumentTool(),
  delete_file: () => new DeleteFileTool(),
  list_files: () => new ListFilesTool(),
  search_project: () => new SearchProjectTool(),
  bib_lookup: () => new BibLookupTool(),
  doc_structure_map: () => new DocStructureMapTool(),
  bib_manage: () => new BibManageTool(),
  label_ref_audit: () => new LabelRefAuditTool(),
  view_file: () => new ViewFileTool(),
  compile_latex: () => new CompileLatexTool(),
  sync_workspace_changes: () => new SyncWorkspaceChangesTool(),
  run_command: () => new RunCommandTool(),
  write_workspace_file: () => new WriteWorkspaceFileTool(),
  inspect_python_environment: () => new InspectPythonEnvironmentTool(),
  start_agent_team: () => new StartAgentTeamTool(),
  handoff_to_agent: () => new HandoffToAgentTool(),
  return_from_handoff: () => new ReturnFromHandoffTool(),
  propose_memory: () => new ProposeMemoryTool(),
}

// Tools that must never be available to sub-agents (prevent recursion)
const CHILD_AGENT_BLACKLIST = new Set([
  'start_agent_task',
  'start_agent_team',
  'handoff_to_agent',
  'activate_skill',
  'propose_memory',
])

// Tool name format: must start with a letter, then letters/digits/underscores
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/i

/**
 * Build a ToolRegistry containing only the specified tools.
 * @param {string[]} toolNames - Tool names to include
 * @returns {ToolRegistry}
 */
export function buildToolRegistry(toolNames) {
  const registry = new ToolRegistry()
  const seen = new Set()
  for (const name of toolNames) {
    if (!TOOL_NAME_RE.test(name)) {
      console.warn(`[ToolPool] Invalid tool name "${name}", skipping`)
      continue
    }
    if (seen.has(name)) {
      console.warn(`[ToolPool] Duplicate tool name "${name}", skipping`)
      continue
    }
    seen.add(name)
    if (CHILD_AGENT_BLACKLIST.has(name)) {
      console.warn(`[ToolPool] Tool "${name}" is blacklisted for sub-agents, skipping`)
      continue
    }
    const factory = TOOL_FACTORIES[name]
    if (!factory) {
      console.warn(`[ToolPool] Unknown tool name "${name}", skipping`)
      continue
    }
    registry.register(factory())
  }
  return registry
}

/**
 * Get all available tool names.
 * @returns {string[]}
 */
export function getAvailableToolNames() {
  return Object.keys(TOOL_FACTORIES)
}
