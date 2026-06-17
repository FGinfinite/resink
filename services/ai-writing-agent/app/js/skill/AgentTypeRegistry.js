import { readdir, readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_AGENTS_DIR = path.resolve(__dirname, '../../../agents')
const MAX_AGENT_TURNS_LIMIT = settings.agentTypes?.maxTurnsLimit || 50
const MAX_TOOLS_PER_AGENT = settings.agentTypes?.maxToolsPerAgent || 20
const MAX_BODY_LENGTH = settings.agentTypes?.maxBodyLength || 32768 // 32 KB

// Frontmatter constraints
const MAX_NAME_LENGTH = settings.agentTypes?.maxNameLength || 64
const MAX_DESCRIPTION_LENGTH = settings.agentTypes?.maxDescriptionLength || 256
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
// Control characters except newline (\n = 0x0a)
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x09\x0b-\x1f\x7f]/g

/**
 * Registry for agent type definitions loaded from .md files.
 * Each file contains YAML frontmatter with name, description, tools, maxTurns
 * followed by the agent's system prompt body.
 */
export class AgentTypeRegistry {
  constructor(agentsDir = DEFAULT_AGENTS_DIR) {
    this.agentsDir = path.resolve(agentsDir)
    this.agents = new Map()
  }

  /**
   * Load all .md agent type files from the agents directory.
   */
  async loadAll() {
    // Resolve agentsDir to its real path to ensure consistent symlink comparison
    try {
      this.agentsDir = await realpath(this.agentsDir)
    } catch {
      // If agentsDir itself doesn't exist, readdir below will handle it
    }

    let entries
    try {
      entries = await readdir(this.agentsDir)
    } catch (error) {
      logger.warn(
        { err: error, dir: this.agentsDir },
        'Failed to read agents directory'
      )
      return
    }

    const mdFiles = entries.filter(f => f.endsWith('.md'))

    for (const file of mdFiles) {
      try {
        const filePath = path.join(this.agentsDir, file)
        const resolvedPath = await realpath(filePath)
        const rel = path.relative(this.agentsDir, resolvedPath)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          logger.warn({ filePath, resolvedPath }, 'Skipping agent type file outside agents directory (possible symlink)')
          continue
        }
        const content = await readFile(resolvedPath, 'utf-8')
        const parsed = this._parseFrontmatter(content)

        if (!parsed.name) {
          logger.warn({ file }, 'Agent type file missing name in frontmatter')
          continue
        }

        // Validate name: allowed characters and length
        if (!NAME_PATTERN.test(parsed.name)) {
          logger.warn({ file, name: parsed.name }, 'Agent type name contains invalid characters (only a-zA-Z0-9_- allowed), skipping')
          continue
        }
        if (parsed.name.length > MAX_NAME_LENGTH) {
          logger.warn({ file, name: parsed.name, max: MAX_NAME_LENGTH }, 'Agent type name exceeds maximum length, skipping')
          continue
        }

        // Strip control characters from description (preserve \n)
        if (parsed.description) {
          parsed.description = parsed.description.replace(CONTROL_CHAR_RE, '')
        }

        // Validate description length
        if (parsed.description && parsed.description.length > MAX_DESCRIPTION_LENGTH) {
          logger.warn({ file, name: parsed.name, length: parsed.description.length, max: MAX_DESCRIPTION_LENGTH }, 'Agent type description exceeds maximum length, skipping')
          continue
        }

        if (this.agents.has(parsed.name)) {
          logger.warn({ name: parsed.name, file }, 'Agent type "%s" already registered, skipping duplicate', parsed.name)
          continue
        }

        this.agents.set(parsed.name, parsed)
        logger.debug({ name: parsed.name, file }, 'Agent type loaded')
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to load agent type file')
      }
    }

    logger.info(
      { count: this.agents.size },
      'Agent type registry loaded'
    )
  }

  /**
   * Get an agent type by name.
   * @param {string} name
   * @returns {{ name: string, description: string, tools: string[], maxTurns: number, body: string } | undefined}
   */
  get(name) {
    return this.agents.get(name)
  }

  /**
   * Get all agent type metadata (without body).
   * @returns {Array<{ name: string, description: string, tools: string[], maxTurns: number }>}
   */
  getAll() {
    return Array.from(this.agents.values()).map(a => ({
      name: a.name,
      description: a.description,
      tools: a.tools,
      maxTurns: a.maxTurns,
    }))
  }

  /**
   * Parse YAML-like frontmatter from a markdown file.
   * Handles tools as comma-separated string -> array and maxTurns as number.
   * @param {string} content - Raw file content
   * @returns {{ name: string, description: string, tools: string[], maxTurns: number, body: string }}
   */
  _parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!match) {
      return { name: '', description: '', tools: [], maxTurns: 5, body: content }
    }

    const frontmatter = match[1]
    const body = match[2].trim()
    const meta = { name: '', description: '', tools: [], maxTurns: 5, body }

    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()

      switch (key) {
        case 'name':
          meta.name = value
          break
        case 'description':
          meta.description = value
          break
        case 'tools':
          meta.tools = value
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
          break
        case 'maxTurns':
          meta.maxTurns = parseInt(value, 10) || 5
          break
      }
    }

    // Clamp maxTurns to hard upper limit
    meta.maxTurns = Math.min(meta.maxTurns, MAX_AGENT_TURNS_LIMIT)

    // Truncate tools array if it exceeds the maximum
    if (meta.tools.length > MAX_TOOLS_PER_AGENT) {
      logger.warn(
        { name: meta.name, toolCount: meta.tools.length, max: MAX_TOOLS_PER_AGENT },
        'Agent type has too many tools, truncating to %d',
        MAX_TOOLS_PER_AGENT
      )
      meta.tools = meta.tools.slice(0, MAX_TOOLS_PER_AGENT)
    }

    // Truncate body if it exceeds the maximum length
    if (meta.body.length > MAX_BODY_LENGTH) {
      logger.warn(
        { name: meta.name, length: meta.body.length, max: MAX_BODY_LENGTH },
        'Agent type body exceeds maximum length, truncating'
      )
      meta.body = meta.body.slice(0, MAX_BODY_LENGTH)
    }

    return meta
  }
}

export default AgentTypeRegistry
