import { MemoryProvider } from './MemoryProvider.js'
import { db } from '../mongodb.js'

/**
 * Provides project-level rules (Markdown) from the aiProjectRules collection.
 */
export class ProjectRulesProvider extends MemoryProvider {
  constructor() {
    super('projectRules')
  }

  async getContent(projectId) {
    const doc = await db.aiProjectRules.findOne(
      { projectId },
      { projection: { content: 1 } }
    )
    return doc?.content || null
  }
}
