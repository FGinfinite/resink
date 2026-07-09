import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'

const readSkillReferenceSchema = z.object({
  skill: z.string().describe('Directory-based skill package name.'),
  path: z.string().describe('Declared reference path, for example references/style-guide.md.'),
})

export class ReadSkillReferenceTool extends Tool {
  constructor(skillRegistry) {
    super({
      name: 'read_skill_reference',
      description: `Load one declared reference file from an activated directory-based skill package.
Only references listed by activate_skill can be read. Host paths, absolute paths, and path traversal are rejected by the skill registry.`,
      parameters: readSkillReferenceSchema,
    })
    this.skillRegistry = skillRegistry
  }

  async execute({ skill, path }) {
    if (!this.skillRegistry?.readReference) {
      return ToolResult.error('Skill registry does not support reference loading.')
    }

    const result = await this.skillRegistry.readReference(skill, path)
    if (!result) {
      return ToolResult.error(`Unknown skill reference "${path}" for skill "${skill}".`)
    }

    return ToolResult.success(result.content, {
      skillName: result.skillName,
      path: result.path,
      name: result.name,
      content: result.content,
      provenance: result.provenance,
      events: [{
        type: 'skill.reference.loaded',
        skillName: result.skillName,
        path: result.path,
        provenance: result.provenance,
      }],
    })
  }
}

export default ReadSkillReferenceTool
