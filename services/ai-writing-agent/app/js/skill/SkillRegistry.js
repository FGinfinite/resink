import { readdir, readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_SKILLS_DIR = path.resolve(__dirname, '../../../skills')
const MAX_BODY_LENGTH = settings.skills?.maxBodyLength || 32768 // 32 KB

// Frontmatter constraints
const MAX_NAME_LENGTH = settings.skills?.maxNameLength || 64
const MAX_DESCRIPTION_LENGTH = settings.skills?.maxDescriptionLength || 256
const MAX_TRIGGER_HINT_LENGTH = settings.skills?.maxTriggerHintLength || 256
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
// Control characters except newline (\n = 0x0a)
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x09\x0b-\x1f\x7f]/g

/**
 * Registry for loading and managing skill definitions from .md files.
 * Skills are loaded from a directory of markdown files with YAML-like frontmatter.
 */
export class SkillRegistry {
  constructor(skillsDir = DEFAULT_SKILLS_DIR) {
    this.skillsDir = path.resolve(skillsDir)
    this.skills = new Map()
  }

  /**
   * Load all .md skill files from the skills directory.
   * @returns {Promise<SkillRegistry>} this for chaining
   */
  async loadAll() {
    // Resolve skillsDir to its real path to ensure consistent symlink comparison
    try {
      this.skillsDir = await realpath(this.skillsDir)
    } catch {
      // If skillsDir itself doesn't exist, readdir below will handle it
    }

    let files
    try {
      files = await readdir(this.skillsDir)
    } catch (err) {
      logger.warn({ err, skillsDir: this.skillsDir }, 'Failed to read skills directory')
      return this
    }

    const mdFiles = files.filter(f => f.endsWith('.md'))

    for (const file of mdFiles) {
      try {
        const filePath = path.join(this.skillsDir, file)
        const resolvedPath = await realpath(filePath)
        const rel = path.relative(this.skillsDir, resolvedPath)
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          logger.warn({ filePath, resolvedPath }, 'Skipping skill file outside skills directory (possible symlink)')
          continue
        }
        const content = await readFile(resolvedPath, 'utf-8')
        const parsed = this._parseFrontmatter(content)

        if (!parsed.meta.name) {
          logger.warn({ file }, 'Skill file missing name in frontmatter, skipping')
          continue
        }

        // Validate name: allowed characters and length
        if (!NAME_PATTERN.test(parsed.meta.name)) {
          logger.warn({ file, name: parsed.meta.name }, 'Skill name contains invalid characters (only a-zA-Z0-9_- allowed), skipping')
          continue
        }
        if (parsed.meta.name.length > MAX_NAME_LENGTH) {
          logger.warn({ file, name: parsed.meta.name, max: MAX_NAME_LENGTH }, 'Skill name exceeds maximum length, skipping')
          continue
        }

        // Strip control characters from description and triggerHint (preserve \n)
        if (parsed.meta.description) {
          parsed.meta.description = parsed.meta.description.replace(CONTROL_CHAR_RE, '')
        }
        if (parsed.meta.triggerHint) {
          parsed.meta.triggerHint = parsed.meta.triggerHint.replace(CONTROL_CHAR_RE, '')
        }

        // Validate description length
        if (parsed.meta.description && parsed.meta.description.length > MAX_DESCRIPTION_LENGTH) {
          logger.warn({ file, name: parsed.meta.name, length: parsed.meta.description.length, max: MAX_DESCRIPTION_LENGTH }, 'Skill description exceeds maximum length, skipping')
          continue
        }

        // Validate triggerHint length
        if (parsed.meta.triggerHint && parsed.meta.triggerHint.length > MAX_TRIGGER_HINT_LENGTH) {
          logger.warn({ file, name: parsed.meta.name, length: parsed.meta.triggerHint.length, max: MAX_TRIGGER_HINT_LENGTH }, 'Skill triggerHint exceeds maximum length, skipping')
          continue
        }

        if (this.skills.has(parsed.meta.name)) {
          logger.warn({ name: parsed.meta.name, file }, 'Skill "%s" already registered, skipping duplicate', parsed.meta.name)
          continue
        }

        let { body } = parsed
        if (body.length > MAX_BODY_LENGTH) {
          logger.warn(
            { skillName: parsed.meta.name, length: body.length, max: MAX_BODY_LENGTH },
            'Skill body exceeds maximum length, truncating'
          )
          body = body.slice(0, MAX_BODY_LENGTH)
        }

        this.skills.set(parsed.meta.name, {
          name: parsed.meta.name,
          description: parsed.meta.description || '',
          triggerHint: parsed.meta.triggerHint || '',
          body,
        })

        logger.debug({ skillName: parsed.meta.name, file }, 'Skill loaded')
      } catch (err) {
        logger.warn({ err, file }, 'Failed to load skill file')
      }
    }

    logger.info({ count: this.skills.size }, 'Skills loaded')
    return this
  }

  /**
   * Get summary list of all skills (without body).
   * @returns {Array<{name: string, description: string, triggerHint: string}>}
   */
  getAll() {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      description: s.description,
      triggerHint: s.triggerHint,
    }))
  }

  /**
   * Get a full skill definition by name.
   * @param {string} name - Skill name
   * @returns {{name: string, description: string, triggerHint: string, body: string}|undefined}
   */
  get(name) {
    return this.skills.get(name)
  }

  /**
   * Build a formatted description string listing all available skills.
   * Used in the activate_skill tool description.
   * @returns {string}
   */
  buildSkillListDescription() {
    const lines = []
    for (const skill of this.skills.values()) {
      lines.push(`- ${skill.name}: ${skill.description} (trigger: ${skill.triggerHint})`)
    }
    return lines.join('\n')
  }

  /**
   * Parse frontmatter and body from a markdown file.
   * Frontmatter is delimited by --- markers at the start of the file.
   * @param {string} content - Raw file content
   * @returns {{meta: object, body: string}}
   */
  _parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) {
      return { meta: {}, body: content }
    }

    const meta = {}
    const lines = match[1].split('\n')
    for (const line of lines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      if (key) {
        meta[key] = value
      }
    }

    return { meta, body: match[2].trim() }
  }
}

export default SkillRegistry
