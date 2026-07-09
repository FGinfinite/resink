import { readdir, readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import logger from '@overleaf/logger'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_PROFILES_DIR = path.resolve(__dirname, '../../../profiles')
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/
const LIST_KEYS = new Set(['artifactGlobs', 'commandHints'])

export class ProfileRegistry {
  constructor(profilesDir = DEFAULT_PROFILES_DIR) {
    this.profilesDir = path.resolve(profilesDir)
    this.profiles = new Map()
  }

  async loadAll() {
    try {
      this.profilesDir = await realpath(this.profilesDir)
    } catch {
      // Missing profile dir is handled by readdir below.
    }

    let files
    try {
      files = await readdir(this.profilesDir)
    } catch (error) {
      logger.warn({ err: error, profilesDir: this.profilesDir }, 'Failed to read runtime profiles directory')
      return this
    }

    for (const file of files.filter(file => file.endsWith('.md'))) {
      try {
        const filePath = path.join(this.profilesDir, file)
        const resolvedPath = await realpath(filePath)
        const relative = path.relative(this.profilesDir, resolvedPath)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          logger.warn({ filePath, resolvedPath }, 'Skipping profile outside profile directory')
          continue
        }

        const parsed = parseFrontmatter(await readFile(resolvedPath, 'utf8'))
        const profile = normalizeProfile(parsed.meta, parsed.body, file)
        if (this.profiles.has(profile.name)) {
          logger.warn({ name: profile.name, file }, 'Runtime profile already registered, skipping duplicate')
          continue
        }
        this.profiles.set(profile.name, profile)
      } catch (error) {
        logger.warn({ err: error, file }, 'Failed to load runtime profile')
      }
    }

    return this
  }

  get(name) {
    return this.profiles.get(name)
  }

  getAll() {
    return Array.from(this.profiles.values()).map(profile => ({
      name: profile.name,
      description: profile.description,
      artifactGlobs: profile.artifactGlobs,
      commandHints: profile.commandHints,
      outputFormat: profile.outputFormat,
    }))
  }

  buildPrompt(profileName, userPrompt) {
    const profile = this.get(profileName)
    if (!profile) {
      throw new ProfileRegistryError(`Unknown runtime profile: ${profileName}`)
    }
    return buildProfilePrompt(profile, userPrompt)
  }
}

export class ProfileRegistryError extends Error {}

export async function loadDefaultProfileRegistry() {
  const registry = new ProfileRegistry()
  await registry.loadAll()
  return registry
}

export function buildProfilePrompt(profile, userPrompt) {
  const lines = [
    `Runtime profile: ${profile.name}`,
    '',
    profile.instructions,
  ]

  if (profile.commandHints.length > 0) {
    lines.push('', 'Allowed command hints:', ...profile.commandHints.map(hint => `- ${hint}`))
  }
  if (profile.artifactGlobs.length > 0) {
    lines.push('', 'Collect artifacts matching:', ...profile.artifactGlobs.map(glob => `- ${glob}`))
  }
  if (profile.outputFormat) {
    lines.push('', 'Expected output format:', profile.outputFormat)
  }

  lines.push('', 'User request:', userPrompt)
  return lines.join('\n')
}

function normalizeProfile(meta, body, file) {
  const name = meta.name || file.replace(/\.md$/, '')
  if (!NAME_PATTERN.test(name)) {
    throw new ProfileRegistryError(`Invalid profile name: ${name}`)
  }
  return {
    name,
    description: meta.description || '',
    artifactGlobs: meta.artifactGlobs || [],
    commandHints: meta.commandHints || [],
    outputFormat: meta.outputFormat || '',
    instructions: body.trim(),
  }
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { meta: {}, body: content }
  }

  const meta = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (!key) continue
    meta[key] = LIST_KEYS.has(key)
      ? value.split(',').map(item => item.trim()).filter(Boolean)
      : value
  }
  return { meta, body: match[2] }
}

export default ProfileRegistry
