import { readdir, readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { SkillDependencyResolver } from '../python/SkillDependencyResolver.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_SKILLS_DIR = path.resolve(__dirname, '../../../skills')
const MAX_BODY_LENGTH = settings.skills?.maxBodyLength || 32768 // 32 KB

// Frontmatter constraints
const MAX_NAME_LENGTH = settings.skills?.maxNameLength || 64
const MAX_DESCRIPTION_LENGTH = settings.skills?.maxDescriptionLength || 256
const MAX_TRIGGER_HINT_LENGTH = settings.skills?.maxTriggerHintLength || 256
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CAPABILITY_LOCAL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9_.-]+)?$/
const VALID_CAPABILITY_ROLES = new Set([
  'worker',
  'coordinator',
  'critic',
  'reducer',
  'handoff-specialist',
  'background-explorer',
])
const SAFE_SKILL_AGENT_TOOLS = new Set([
  'read_document',
  'list_files',
  'search_project',
  'doc_structure_map',
  'label_ref_audit',
  'bib_lookup',
  'run_skill_script',
  'read_skill_reference',
  'compile_latex',
])
// Control characters except newline (\n = 0x0a)
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x09\x0b-\x1f\x7f]/g

/**
 * Registry for loading and managing directory-based skill packages.
 * Each skill package is stored at skills/<name>/SKILL.md with optional
 * references/ and scripts/ package assets.
 */
export class SkillPackageRegistry {
  constructor(skillsDir = DEFAULT_SKILLS_DIR) {
    this.skillsDir = path.resolve(skillsDir)
    this.skills = new Map()
    this.referenceFiles = new Map()
    this.scriptFiles = new Map()
    this.packageDirs = new Map()
    this.dependencyResolver = new SkillDependencyResolver({ skillRegistry: this })
  }

  /**
   * Load all directory-based skill packages from the skills directory.
   * @returns {Promise<SkillPackageRegistry>} this for chaining
   */
  async loadAll() {
    try {
      this.skillsDir = await realpath(this.skillsDir)
    } catch {
      // If skillsDir itself doesn't exist, readdir below will handle it
    }

    let entries
    try {
      entries = await readdir(this.skillsDir, { withFileTypes: true })
    } catch (err) {
      logger.warn({ err, skillsDir: this.skillsDir }, 'Failed to read skills directory')
      return this
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await this._loadPackage(entry.name)
    }

    logger.info({ count: this.skills.size }, 'Skills loaded')
    return this
  }

  async _loadPackage(packageName) {
    if (!NAME_PATTERN.test(packageName) || packageName.length > MAX_NAME_LENGTH) {
      logger.warn({ packageName }, 'Skill package directory name is invalid, skipping')
      return
    }

    const packageDir = path.join(this.skillsDir, packageName)
    let resolvedPackageDir
    try {
      resolvedPackageDir = await realpath(packageDir)
    } catch (err) {
      logger.warn({ err, packageDir }, 'Failed to resolve skill package directory')
      return
    }

    if (!this._isInsideSkillsDir(resolvedPackageDir)) {
      logger.warn({ packageDir, resolvedPackageDir }, 'Skipping skill package outside skills directory (possible symlink)')
      return
    }

    const skillFile = path.join(resolvedPackageDir, 'SKILL.md')
    let resolvedSkillFile
    try {
      resolvedSkillFile = await realpath(skillFile)
    } catch (err) {
      logger.warn({ err, skillFile }, 'Skill package missing SKILL.md, skipping')
      return
    }

    if (!this._isInsideDirectory(resolvedPackageDir, resolvedSkillFile)) {
      logger.warn({ skillFile, resolvedSkillFile }, 'Skipping SKILL.md outside package directory (possible symlink)')
      return
    }

    try {
      const content = await readFile(resolvedSkillFile, 'utf-8')
      const parsed = this._parseFrontmatter(content)
      const skill = await this._buildSkillPackage({
        packageName,
        packageDir: resolvedPackageDir,
        skillFile: resolvedSkillFile,
        parsed,
      })

      if (skill) {
        this.skills.set(skill.name, skill)
        logger.debug({ skillName: skill.name, packageDir: resolvedPackageDir }, 'Skill loaded')
      }
    } catch (err) {
      logger.warn({ err, packageName }, 'Failed to load skill package')
    }
  }

  async _buildSkillPackage({ packageName, packageDir, parsed }) {
    if (!parsed.meta.name) {
      logger.warn({ packageName }, 'Skill package missing name in frontmatter, skipping')
      return undefined
    }

    if (parsed.meta.name !== packageName) {
      logger.warn({ packageName, name: parsed.meta.name }, 'Skill name must match package directory, skipping')
      return undefined
    }

    if (!NAME_PATTERN.test(parsed.meta.name)) {
      logger.warn({ packageName, name: parsed.meta.name }, 'Skill name must be lowercase hyphenated, skipping')
      return undefined
    }

    if (parsed.meta.description) {
      parsed.meta.description = parsed.meta.description.replace(CONTROL_CHAR_RE, '')
    }
    if (parsed.meta.triggerHint) {
      parsed.meta.triggerHint = parsed.meta.triggerHint.replace(CONTROL_CHAR_RE, '')
    }

    if (parsed.meta.description && parsed.meta.description.length > MAX_DESCRIPTION_LENGTH) {
      logger.warn({ packageName, length: parsed.meta.description.length, max: MAX_DESCRIPTION_LENGTH }, 'Skill description exceeds maximum length, skipping')
      return undefined
    }

    if (parsed.meta.triggerHint && parsed.meta.triggerHint.length > MAX_TRIGGER_HINT_LENGTH) {
      logger.warn({ packageName, length: parsed.meta.triggerHint.length, max: MAX_TRIGGER_HINT_LENGTH }, 'Skill triggerHint exceeds maximum length, skipping')
      return undefined
    }

    if (this.skills.has(parsed.meta.name)) {
      logger.warn({ name: parsed.meta.name, packageName }, 'Skill "%s" already registered, skipping duplicate', parsed.meta.name)
      return undefined
    }

    let instructions = parsed.body
    if (instructions.length > MAX_BODY_LENGTH) {
      logger.warn(
        { skillName: parsed.meta.name, length: instructions.length, max: MAX_BODY_LENGTH },
        'Skill body exceeds maximum length, truncating'
      )
      instructions = instructions.slice(0, MAX_BODY_LENGTH)
    }

    this.packageDirs.set(parsed.meta.name, packageDir)
    const capabilityMetadata = await this._loadAgentCapabilities(parsed.meta.name)
    const skill = {
      name: parsed.meta.name,
      description: parsed.meta.description || '',
      triggerHint: parsed.meta.triggerHint || '',
      instructions,
      body: instructions,
      references: await this._listPackageAssets(packageDir, 'references'),
      scripts: await this._listPackageAssets(packageDir, 'scripts'),
      agentCapabilities: capabilityMetadata.capabilities,
      agentCapabilityDiagnostics: capabilityMetadata.diagnostics,
      provenance: {
        source: 'local-package',
        packageName: parsed.meta.name,
        skillFile: 'SKILL.md',
      },
    }
    skill.python = await this.dependencyResolver.resolve(parsed.meta.name, { skill })
    return skill
  }

  async _loadAgentCapabilities(skillName) {
    const diagnostics = { loaded: 0, skipped: [] }
    const capabilities = []
    const skillJson = await this.readPackageFile(skillName, 'skill.json')
    if (!skillJson) return { capabilities, diagnostics }

    let parsed
    try {
      parsed = JSON.parse(skillJson.content)
    } catch {
      return { capabilities, diagnostics }
    }

    if (!Array.isArray(parsed.agentCapabilities)) {
      return { capabilities, diagnostics }
    }

    for (const rawCapability of parsed.agentCapabilities) {
      const normalized = this._normalizeAgentCapability(skillName, rawCapability)
      if (!normalized.ok) {
        diagnostics.skipped.push({
          name: rawCapability?.name || null,
          reason: normalized.reason,
        })
        continue
      }
      capabilities.push(normalized.capability)
    }
    diagnostics.loaded = capabilities.length
    return { capabilities, diagnostics }
  }

  _normalizeAgentCapability(skillName, rawCapability) {
    if (!rawCapability || typeof rawCapability !== 'object' || Array.isArray(rawCapability)) {
      return { ok: false, reason: 'skill-capability-must-be-object' }
    }

    const name = typeof rawCapability.name === 'string' ? rawCapability.name.trim() : ''
    const prefix = `${skillName}.`
    const localName = name.startsWith(prefix) ? name.slice(prefix.length) : ''
    if (!localName || !CAPABILITY_LOCAL_NAME_PATTERN.test(localName)) {
      return { ok: false, reason: 'invalid-skill-capability-name' }
    }
    if (!VERSION_PATTERN.test(rawCapability.version || '')) {
      return { ok: false, reason: 'invalid-skill-capability-version' }
    }
    if (typeof rawCapability.description !== 'string' || !rawCapability.description.trim()) {
      return { ok: false, reason: 'missing-skill-capability-description' }
    }
    if (!VALID_CAPABILITY_ROLES.has(rawCapability.role)) {
      return { ok: false, reason: 'invalid-skill-capability-role' }
    }
    const promptRef = this._normalizeSkillCapabilityPromptRef(skillName, rawCapability.promptRef)
    if (!promptRef) {
      return { ok: false, reason: 'invalid-skill-capability-prompt-ref' }
    }
    if (!isObjectSchema(rawCapability.inputSchema)) {
      return { ok: false, reason: 'invalid-skill-capability-input-schema' }
    }
    if (!isObjectSchema(rawCapability.outputSchema)) {
      return { ok: false, reason: 'invalid-skill-capability-output-schema' }
    }
    const policy = normalizeSkillCapabilityPolicy(rawCapability.defaultPolicy)
    if (!policy.ok) {
      return { ok: false, reason: policy.reason }
    }
    const scripts = normalizeDeclaredScripts(rawCapability.scripts)
    if (!scripts.ok) {
      return { ok: false, reason: scripts.reason }
    }

    return {
      ok: true,
      capability: {
        name,
        version: rawCapability.version.trim(),
        description: rawCapability.description.trim().replace(CONTROL_CHAR_RE, ''),
        role: rawCapability.role,
        triggerHints: normalizeStringArray(rawCapability.triggerHints),
        inputSchema: rawCapability.inputSchema,
        outputSchema: rawCapability.outputSchema,
        defaultModelTier: rawCapability.defaultModelTier || 'standard',
        defaultToolsets: normalizeStringArray(rawCapability.defaultToolsets),
        defaultPolicy: policy.value,
        contextPolicy:
          rawCapability.contextPolicy && typeof rawCapability.contextPolicy === 'object'
            ? rawCapability.contextPolicy
            : {},
        promptRef,
        examples: Array.isArray(rawCapability.examples) ? rawCapability.examples : [],
        safety: rawCapability.safety || { classification: 'skill' },
        scripts: scripts.value,
        provenance: {
          source: 'skill-package',
          skillName,
          relativePath: 'skill.json',
        },
      },
    }
  }

  _normalizeSkillCapabilityPromptRef(skillName, promptRef) {
    if (!promptRef || typeof promptRef !== 'object') return null
    if (promptRef.kind === 'skill') {
      return { kind: 'skill', skillName, ref: 'SKILL.md' }
    }
    if (promptRef.kind !== 'skill-reference') return null
    const normalizedPath = this._normalizeReferencePath(promptRef.ref)
    if (!normalizedPath) return null
    return {
      kind: 'skill-reference',
      skillName,
      ref: normalizedPath,
    }
  }

  async _listPackageAssets(packageDir, assetDirName) {
    const assetDir = path.join(packageDir, assetDirName)
    let resolvedAssetDir
    try {
      resolvedAssetDir = await realpath(assetDir)
    } catch {
      return []
    }

    if (!this._isInsideDirectory(packageDir, resolvedAssetDir)) {
      logger.warn({ assetDir, resolvedAssetDir }, 'Skipping skill asset directory outside package directory (possible symlink)')
      return []
    }

    let entries
    try {
      entries = await readdir(resolvedAssetDir, { withFileTypes: true })
    } catch {
      return []
    }

    const assets = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const assetPath = path.join(resolvedAssetDir, entry.name)
      let resolvedAssetPath
      try {
        resolvedAssetPath = await realpath(assetPath)
      } catch {
        continue
      }
      if (!this._isInsideDirectory(resolvedAssetDir, resolvedAssetPath)) {
        logger.warn({ assetPath, resolvedAssetPath }, 'Skipping skill asset outside asset directory (possible symlink)')
        continue
      }
      const relativePath = path.posix.join(assetDirName, entry.name)
      const asset = {
        name: entry.name,
        relativePath,
      }
      if (assetDirName === 'scripts') {
        asset.runtime = inferScriptRuntime(entry.name)
      }
      assets.push(asset)
      if (assetDirName === 'references') {
        const skillName = path.basename(packageDir)
        this.referenceFiles.set(`${skillName}:${relativePath}`, resolvedAssetPath)
      } else if (assetDirName === 'scripts') {
        const skillName = path.basename(packageDir)
        this.scriptFiles.set(`${skillName}:${entry.name}`, {
          path: resolvedAssetPath,
          relativePath,
          runtime: inferScriptRuntime(entry.name),
        })
      }
    }
    return assets
  }

  _isInsideSkillsDir(targetPath) {
    return this._isInsideDirectory(this.skillsDir, targetPath)
  }

  _isInsideDirectory(parentDir, targetPath) {
    const rel = path.relative(parentDir, targetPath)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  /**
   * Get summary list of all skills (without instructions).
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
   * Get a full skill package by name.
   * @param {string} name - Skill name
   * @returns {object|undefined}
   */
  get(name) {
    return this.skills.get(name)
  }

  async readReference(skillName, relativePath) {
    const skill = this.get(skillName)
    if (!skill) return undefined

    const normalizedPath = this._normalizeReferencePath(relativePath)
    const reference = skill.references.find(ref => ref.relativePath === normalizedPath)
    if (!reference) return undefined

    const key = `${skillName}:${normalizedPath}`
    const filePath = this.referenceFiles.get(key)
    if (!filePath) return undefined

    const content = await readFile(filePath, 'utf-8')
    let body = content
    if (body.length > MAX_BODY_LENGTH) {
      logger.warn(
        { skillName, relativePath: normalizedPath, length: body.length, max: MAX_BODY_LENGTH },
        'Skill reference exceeds maximum length, truncating'
      )
      body = body.slice(0, MAX_BODY_LENGTH)
    }
    return {
      skillName,
      path: normalizedPath,
      name: reference.name,
      content: body,
      provenance: {
        source: 'local-package',
        packageName: skillName,
        relativePath: normalizedPath,
      },
    }
  }

  async readScript(skillName, scriptName) {
    const skill = this.get(skillName)
    if (!skill) return undefined

    const normalizedName = this._normalizeScriptName(scriptName)
    const script = skill.scripts.find(item => item.name === normalizedName)
    if (!script) return undefined

    const scriptInfo = this.scriptFiles.get(`${skillName}:${normalizedName}`)
    if (!scriptInfo) return undefined

    const content = await readFile(scriptInfo.path, 'utf-8')
    if (content.length > MAX_BODY_LENGTH) {
      logger.warn(
        { skillName, scriptName: normalizedName, length: content.length, max: MAX_BODY_LENGTH },
        'Skill script exceeds maximum length, skipping'
      )
      return undefined
    }
    return {
      skillName,
      name: normalizedName,
      relativePath: scriptInfo.relativePath,
      runtime: scriptInfo.runtime,
      python: skill.python || { required: false, status: 'none' },
      content,
      provenance: {
        source: 'local-package',
        packageName: skillName,
        relativePath: scriptInfo.relativePath,
      },
    }
  }

  async readPackageFile(skillName, relativePath) {
    const packageDir = this.packageDirs.get(skillName)
    const normalizedPath = this._normalizePackageFilePath(relativePath)
    if (!packageDir || !normalizedPath) return undefined

    const filePath = path.join(packageDir, normalizedPath)
    let resolvedPath
    try {
      resolvedPath = await realpath(filePath)
    } catch {
      return undefined
    }
    if (!this._isInsideDirectory(packageDir, resolvedPath)) return undefined

    const content = await readFile(resolvedPath, 'utf-8')
    if (content.length === 0) return undefined
    if (content.length > MAX_BODY_LENGTH) {
      logger.warn(
        { skillName, relativePath: normalizedPath, length: content.length, max: MAX_BODY_LENGTH },
        'Skill package metadata exceeds maximum length, skipping'
      )
      return undefined
    }
    return {
      skillName,
      path: normalizedPath,
      content,
    }
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

  _normalizeReferencePath(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.includes('\\') || rawPath.includes('\0')) {
      return ''
    }
    if (path.posix.isAbsolute(rawPath)) return ''
    const normalized = path.posix.normalize(rawPath)
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      !normalized.startsWith('references/')
    ) {
      return ''
    }
    return normalized
  }

  _normalizeScriptName(rawName) {
    if (typeof rawName !== 'string' || rawName.includes('/') || rawName.includes('\\') || rawName.includes('\0')) {
      return ''
    }
    return rawName
  }

  _normalizePackageFilePath(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.includes('\\') || rawPath.includes('\0')) {
      return ''
    }
    if (path.posix.isAbsolute(rawPath)) return ''
    const normalized = path.posix.normalize(rawPath)
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.includes('/')
    ) {
      return ''
    }
    if (!['skill.json', 'pyproject.toml', 'uv.lock', '.python-version'].includes(normalized)) {
      return ''
    }
    return normalized
  }
}

function inferScriptRuntime(fileName) {
  if (fileName.endsWith('.py')) return 'python3'
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) return 'node'
  if (fileName.endsWith('.rb')) return 'ruby'
  if (fileName.endsWith('.pl')) return 'perl'
  if (fileName.endsWith('.sh')) return 'sh'
  return null
}

function normalizeSkillCapabilityPolicy(policy = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return { ok: true, value: {} }
  }
  const tools = normalizeStringArray(policy.tools)
  if (tools.some(tool => !SAFE_SKILL_AGENT_TOOLS.has(tool))) {
    return { ok: false, reason: 'unsafe-skill-capability-tools' }
  }
  const pythonEnvironments = normalizeStringArray(policy.pythonEnvironments)
  if (pythonEnvironments.some(item => item === '*' || item === 'system' || item === 'host')) {
    return { ok: false, reason: 'unsafe-skill-capability-python-env' }
  }
  if (policy.network && policy.network !== 'deny' && policy.network !== 'package-index-proxy') {
    return { ok: false, reason: 'unsafe-skill-capability-network' }
  }
  if (policy.allowSpawn === true || policy.allowHandoff === true) {
    return { ok: false, reason: 'unsafe-skill-capability-spawn' }
  }
  return {
    ok: true,
    value: {
      tools,
      fileGlobs: normalizeStringArray(policy.fileGlobs),
      writeGlobs: normalizeStringArray(policy.writeGlobs),
      network: policy.network || 'deny',
      pythonEnvironments,
      modelTiers: normalizeStringArray(policy.modelTiers),
      maxDepth: normalizeNonNegativeLimit(policy.maxDepth),
      maxParallelTasks: normalizeNonNegativeLimit(policy.maxParallelTasks),
      maxToolCalls: normalizeNonNegativeLimit(policy.maxToolCalls),
      allowSpawn: false,
      allowHandoff: false,
    },
  }
}

function normalizeDeclaredScripts(value) {
  if (value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, reason: 'invalid-skill-capability-scripts' }
  const scripts = []
  for (const script of value) {
    if (
      typeof script !== 'string' ||
      !script.trim() ||
      script.includes('/') ||
      script.includes('\\') ||
      script.includes('\0') ||
      script === '..'
    ) {
      return { ok: false, reason: 'invalid-skill-capability-scripts' }
    }
    scripts.push(script.trim())
  }
  return { ok: true, value: [...new Set(scripts)] }
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
    : []
}

function normalizeNonNegativeLimit(value) {
  if (value === undefined || value === null) return null
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null
}

function isObjectSchema(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.type === 'object')
}

export const SkillRegistry = SkillPackageRegistry
export default SkillRegistry
