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
    return ToolResult.success(skill.body, { skillName: name })
  }
}

export default ActivateSkillTool
