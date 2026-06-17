/**
 * Base class for memory providers.
 * Each provider supplies a specific type of persistent context
 * (e.g. project rules, user preferences) to the AI system prompt.
 */
export class MemoryProvider {
  constructor(name) {
    this.name = name
  }

  /**
   * Retrieve content for a given project.
   * @param {string} projectId
   * @returns {Promise<string|null>} Content string or null if none
   */
  async getContent(_projectId) {
    throw new Error('Not implemented')
  }
}
