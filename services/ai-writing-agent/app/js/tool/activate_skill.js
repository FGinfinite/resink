import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'

/**
 * Tool for activating a skill to guide the agent's workflow.
 * When the user's request matches a skill's trigger condition,
 * the agent should call this tool to load the corresponding skill instructions.
 */
export class ActivateSkillTool extends Tool {
  constructor(skillRegistry) {
    const skillList = skillRegistry.buildSkillListDescription()
    super({
      name: 'activate_skill',
      description: `Load a professional skill to guide your workflow. When the user's request matches a skill's trigger condition, you should call this tool first to load the corresponding skill instructions.\n\nAvailable skills:\n${skillList}`,
      parameters: z.object({
        name: z.string().describe('The name of the skill to load'),
      }),
    })
    this.skillRegistry = skillRegistry
  }

  async execute({ name }, _context) {
    const skill = this.skillRegistry.get(name)
    if (!skill) {
      const available = this.skillRegistry
        .getAll()
        .map(s => s.name)
        .join(', ')
      return ToolResult.error(`Unknown skill "${name}". Available skills: ${available}`)
    }
    const instructions = skill.instructions ?? skill.body ?? ''
    const references = skill.references ?? []
    const scripts = skill.scripts ?? []
    const agentCapabilities = skill.agentCapabilities ?? []
    const python = skill.python ?? { required: false, status: 'none' }
    return ToolResult.success(formatSkillActivationOutput({
      instructions,
      references,
      scripts,
      agentCapabilities,
      python,
      skillName: name,
    }), {
      skillName: name,
      instructions,
      references,
      scripts,
      agentCapabilities,
      python,
      provenance: skill.provenance ?? {},
      events: [{
        type: 'skill.activated',
        skillName: name,
        references,
        scripts,
        agentCapabilities,
        python,
        provenance: skill.provenance ?? {},
      }],
    })
  }
}

function formatSkillActivationOutput({ instructions, references, scripts, agentCapabilities, python, skillName }) {
  const lines = [instructions.trimEnd(), '', 'Available skill assets:']
  if (references.length > 0) {
    lines.push('References:')
    for (const reference of references) {
      lines.push(`- ${reference.relativePath || reference.name}`)
    }
  } else {
    lines.push('References: none')
  }
  if (scripts.length > 0) {
    lines.push('Scripts:')
    for (const script of scripts) {
      const runtime = script.runtime ? ` (${script.runtime})` : ''
      lines.push(
        `- run_skill_script skill="${skillName}" script="${script.name}"${runtime}`
      )
    }
  } else {
    lines.push('Scripts: none')
  }
  if (agentCapabilities.length > 0) {
    lines.push('Agent capabilities:')
    for (const capability of agentCapabilities) {
      lines.push(
        `- start_agent_task capabilityName="${capability.name}" (${capability.version || 'unversioned'}): ${capability.description || ''}`.trim()
      )
    }
  } else {
    lines.push('Agent capabilities: none')
  }
  lines.push(formatPythonStatus(python))
  return lines.join('\n')
}

function formatPythonStatus(python = {}) {
  if (!python.required) return 'Python environment: none'
  const packages = (python.packages || [])
    .map(pkg => `${pkg.name || pkg.raw || 'unknown'}${pkg.specifier || ''}`)
    .join(', ')
  const suffix = packages ? `; packages: ${packages}` : ''
  return `Python environment: ${python.status || 'required'}${suffix}`
}

export default ActivateSkillTool
