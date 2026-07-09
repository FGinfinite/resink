import crypto from 'node:crypto'

const PEP_723_START_RE = /^#\s*\/\/\/\s*script\s*$/m
const PEP_723_END_RE = /^#\s*\/\/\/\s*$/m
const QUOTED_VALUE_RE = /["']([^"']+)["']/g

export function sha256Hex(value) {
  const content = Buffer.isBuffer(value) ? value : String(value)
  return crypto.createHash('sha256').update(content).digest('hex')
}

export function sourceFile(path, content, kind) {
  return {
    path,
    kind,
    hash: `sha256:${sha256Hex(content)}`,
  }
}

export function buildDependencyRequest(input = {}) {
  const request = {
    scope: input.scope,
    skillName: input.skillName || null,
    scriptPath: input.scriptPath || null,
    sourceFiles: input.sourceFiles || [],
    requestedPackages: normalizePackages(input.requestedPackages || []),
    requestedPythonVersion: input.requestedPythonVersion || null,
    requestedNetworkPolicy: input.requestedNetworkPolicy || 'none',
    policyFindings: input.policyFindings || [],
    environmentKey: input.environmentKey || null,
  }
  return {
    ...request,
    fingerprint: dependencyFingerprint(request),
  }
}

export function dependencyFingerprint(request) {
  return `sha256:${sha256Hex(stableStringify({
    scope: request.scope,
    skillName: request.skillName || null,
    scriptPath: request.scriptPath || null,
    sourceFiles: request.sourceFiles || [],
    requestedPackages: request.requestedPackages || [],
    requestedPythonVersion: request.requestedPythonVersion || null,
    requestedNetworkPolicy: request.requestedNetworkPolicy || 'none',
    environmentKey: request.environmentKey || null,
  }))}`
}

export function normalizePackages(packages) {
  return packages
    .filter(pkg => pkg && typeof pkg.name === 'string' && pkg.name.trim())
    .map(pkg => ({
      name: normalizePackageName(pkg.name),
      specifier: pkg.specifier || '',
      sourceHint: pkg.sourceHint || inferSourceHint(pkg.raw || pkg.name),
      reason: pkg.reason || '',
      raw: pkg.raw || packageToRaw(pkg),
    }))
    .sort((a, b) => a.raw.localeCompare(b.raw))
}

export function parseSkillJson(content) {
  const parsed = JSON.parse(content)
  const python = parsed?.runtime?.python || null
  const scripts = Array.isArray(parsed?.scripts) ? parsed.scripts : []
  const packages = []
  for (const dep of python?.dependencies || []) {
    packages.push(parseDependencyString(String(dep), 'skill-json'))
  }
  return {
    python: python
      ? {
          environment: python.environment || 'skill',
          pythonVersion: python.pythonVersion || null,
          lockfile: python.lockfile || null,
          projectFile: python.projectFile || null,
          network: python.network || 'none',
          approvedSnapshot: python.approvedSnapshot || null,
        }
      : null,
    scripts: scripts.map(script => ({
      name: script.name,
      path: script.path,
      runtime: script.runtime,
      entrypoint: script.entrypoint,
      timeoutMs: script.timeoutMs,
      outputLimitBytes: script.outputLimitBytes,
    })),
    packages,
    findings: [
      ...sourceFindings(packages),
      ...skillJsonFindings(parsed),
    ],
  }
}

export function parsePyprojectToml(content) {
  const projectBlock = extractTomlSection(content, 'project')
  const toolUvBlock = extractTomlSection(content, 'tool.uv')
  const dependencies = extractTomlArray(projectBlock, 'dependencies')
  const optionalDeps = extractTomlInlineArrays(
    extractTomlSection(content, 'project.optional-dependencies')
  )
  const packages = [
    ...dependencies,
    ...Object.values(optionalDeps).flat(),
  ].map(dep => parseDependencyString(dep, 'pyproject'))
  const requiresPython = extractTomlString(projectBlock, 'requires-python')
  const indexStrategy = extractTomlString(toolUvBlock, 'index-strategy')

  return {
    requestedPythonVersion: requiresPython || null,
    packages,
    uv: {
      indexStrategy: indexStrategy || null,
    },
    findings: [
      ...sourceFindings(packages),
      ...uvStrategyFindings(indexStrategy),
    ],
  }
}

export function parsePep723ScriptMetadata(content) {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex(line => PEP_723_START_RE.test(line))
  if (start === -1) {
    return { found: false, packages: [], findings: [], requestedPythonVersion: null }
  }
  const endOffset = lines.slice(start + 1).findIndex(line => PEP_723_END_RE.test(line))
  if (endOffset === -1) {
    return {
      found: true,
      malformed: true,
      packages: [],
      findings: [{
        code: 'PEP723_UNCLOSED_BLOCK',
        severity: 'high',
        message: 'PEP 723 metadata block is not closed.',
      }],
      requestedPythonVersion: null,
    }
  }
  const body = lines
    .slice(start + 1, start + 1 + endOffset)
    .map(line => line.replace(/^# ?/, ''))
    .join('\n')
  const dependencies = extractTomlArray(body, 'dependencies')
  const packages = dependencies.map(dep => parseDependencyString(dep, 'pep723'))
  const requiresPython = extractTomlString(body, 'requires-python')
  const toolUvBlock = extractTomlSection(body, 'tool.uv')
  const indexStrategy = extractTomlString(toolUvBlock, 'index-strategy')
  return {
    found: true,
    packages,
    requestedPythonVersion: requiresPython || null,
    uv: {
      indexStrategy: indexStrategy || null,
    },
    findings: [
      ...sourceFindings(packages),
      ...uvStrategyFindings(indexStrategy),
    ],
  }
}

export function parseDependencyString(raw, sourceKind = 'unknown') {
  const trimmed = String(raw || '').trim()
  const atIndex = trimmed.indexOf(' @ ')
  const namePart = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex)
  const nameMatch = namePart.match(/^([A-Za-z0-9_.-]+)/)
  const name = nameMatch ? normalizePackageName(nameMatch[1]) : normalizePackageName(trimmed)
  return {
    name,
    specifier: namePart.slice(nameMatch?.[1]?.length || 0).trim(),
    sourceHint: inferSourceHint(trimmed),
    reason: sourceKind,
    raw: trimmed,
  }
}

export function sourceFindings(packages) {
  const findings = []
  for (const pkg of packages) {
    if (pkg.sourceHint === 'direct-url') {
      findings.push({
        code: 'DIRECT_URL_DEPENDENCY',
        severity: 'high',
        message: 'Direct URL dependencies require broker policy review.',
        packageName: pkg.name,
      })
    } else if (pkg.sourceHint === 'vcs') {
      findings.push({
        code: 'VCS_DEPENDENCY',
        severity: 'high',
        message: 'VCS dependencies require immutable source review.',
        packageName: pkg.name,
      })
    } else if (pkg.sourceHint === 'local-path') {
      findings.push({
        code: 'LOCAL_PATH_DEPENDENCY',
        severity: 'medium',
        message: 'Local path dependencies are not reusable shared skill dependencies.',
        packageName: pkg.name,
      })
    }
  }
  return findings
}

function skillJsonFindings(parsed) {
  const findings = []
  const network = parsed?.runtime?.python?.network
  if (network && network !== 'none') {
    findings.push({
      code: 'PYTHON_RUNTIME_NETWORK_REQUESTED',
      severity: 'medium',
      message: 'Python runtime network access must be approved by policy.',
    })
  }
  return findings
}

function uvStrategyFindings(indexStrategy) {
  if (!indexStrategy) return []
  if (indexStrategy === 'first-index') return []
  return [{
    code: 'UNSAFE_UV_INDEX_STRATEGY',
    severity: 'high',
    message: `uv index strategy "${indexStrategy}" is not allowed in product dependency resolution.`,
  }]
}

export function inferSourceHint(raw) {
  const value = String(raw || '').trim()
  if (/(^|\s)git\+|@ git\+|https:\/\/github\.com|ssh:\/\/|git@/.test(value)) {
    return 'vcs'
  }
  if (/@\s*https?:\/\//.test(value) || /^https?:\/\//.test(value)) {
    return 'direct-url'
  }
  if (/@\s*file:/.test(value) || /^\.{1,2}\//.test(value) || /^\//.test(value)) {
    return 'local-path'
  }
  return 'index'
}

function normalizePackageName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-')
}

function packageToRaw(pkg) {
  return `${pkg.name || ''}${pkg.specifier || ''}`
}

function extractTomlSection(content, sectionName) {
  const lines = String(content || '').split(/\r?\n/)
  const startRe = new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*$`)
  const nextSectionRe = /^\s*\[[^\]]+\]\s*$/
  const start = lines.findIndex(line => startRe.test(line))
  if (start === -1) return ''
  const collected = []
  for (const line of lines.slice(start + 1)) {
    if (nextSectionRe.test(line)) break
    collected.push(line)
  }
  return collected.join('\n')
}

function extractTomlString(content, key) {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, 'm')
  return re.exec(String(content || ''))?.[1] || ''
}

function extractTomlArray(content, key) {
  const source = String(content || '')
  const startRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[`, 'm')
  const match = startRe.exec(source)
  if (!match) return []
  let depth = 0
  let end = match.index
  for (let i = match.index; i < source.length; i++) {
    if (source[i] === '[') depth++
    if (source[i] === ']') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const arrayText = source.slice(match.index, end)
  return quotedValues(arrayText)
}

function extractTomlInlineArrays(content) {
  const result = {}
  const lines = String(content || '').split(/\r?\n/)
  for (const line of lines) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)
    if (!match) continue
    result[match[1]] = quotedValues(line)
  }
  return result
}

function quotedValues(value) {
  return Array.from(String(value || '').matchAll(QUOTED_VALUE_RE), match => match[1])
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
