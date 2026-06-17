import logger from '@overleaf/logger'
import settings from '@overleaf/settings'

// Strip control characters except newline (\x0a) to prevent prompt injection
// and malformed content from memory providers.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x09\x0b-\x1f\x7f]/g

let _instance = null

/**
 * Aggregates content from all registered MemoryProviders.
 */
export class MemoryManager {
  constructor() {
    this.providers = []
  }

  register(provider) {
    this.providers.push(provider)
  }

  /**
   * Collect non-empty content from all providers, joined by double newline.
   * @param {string} projectId
   * @returns {Promise<string|null>}
   */
  async getMemoryContent(projectId) {
    const parts = []
    for (const provider of this.providers) {
      try {
        const content = await provider.getContent(projectId)
        if (content) {
          parts.push(content.replace(CONTROL_CHAR_RE, ''))
        }
      } catch (err) {
        logger.warn(
          { err, provider: provider.name, projectId },
          'Memory provider failed'
        )
      }
    }
    if (parts.length === 0) return null
    let result = parts.join('\n\n')
    const maxLen = settings.memory?.maxRulesLength || 10000
    if (result.length > maxLen) {
      result = result.slice(0, maxLen) + '\n... [truncated]'
    }
    return result
  }
}

export function getMemoryManager() {
  return _instance
}

export function setMemoryManager(instance) {
  _instance = instance
}
