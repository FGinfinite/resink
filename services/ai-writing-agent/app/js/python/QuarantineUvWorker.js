import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildDependencyRequest,
  sha256Hex,
  stableStringify,
} from './DependencyMetadata.js'
import { DependencyPolicyEngine } from './DependencyPolicyEngine.js'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const REDACTED = '[redacted]'
const SAFE_ENV_NAMES = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ'])
const SAFE_UV_ENV_NAMES = new Set([
  'UV_CACHE_DIR',
  'UV_INDEX_STRATEGY',
  'UV_NO_PROGRESS',
])
const BROKER_NETWORK_POLICIES = new Set(['restricted', 'package-index-proxy'])
const PACKAGE_INDEX_PROXY_PROTOCOLS = new Set(['http:', 'https:'])
const PACKAGE_INDEX_PROXY_HOST = 'pypi-proxy'
const SECRET_RE =
  /\b(?:Bearer\s+)?(?:sk|pk|key|token|secret|cred)[A-Za-z0-9._~+/=-]{8,}\b/gi
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)[A-Z0-9_]*)=([^\s]+)/gi

export class QuarantineUvWorker {
  constructor(options = {}) {
    this.uvBinary = options.uvBinary || 'uv'
    this.tempPrefix = options.tempPrefix || 'resink-uv-broker-'
    this.tempRoot = options.tempRoot || os.tmpdir()
    this.runner = options.runner || defaultRunner
    this.policyEngine = options.policyEngine || new DependencyPolicyEngine({
      config: options.policyConfig,
    })
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES
    this.networkPolicy = options.networkPolicy || 'restricted'
    this.packageIndexProxyUrl = options.packageIndexProxyUrl || null
    this.baseEnv = options.baseEnv || {
      PATH: process.env.PATH || '',
      HOME: os.tmpdir(),
      UV_NO_PROGRESS: '1',
      UV_INDEX_STRATEGY: 'first-index',
    }
  }

  async resolve(input = {}) {
    const request = normalizeRequest(input.request || input)
    const networkPolicyError = this.validateBrokerNetworkPolicy()
    if (networkPolicyError) {
      return {
        ok: false,
        status: 'failed',
        error: networkPolicyError,
        request,
        policyDecision: null,
        logs: [],
        artifacts: {},
      }
    }
    const policyDecision = this.policyEngine.evaluateRequest(request)
    if (policyDecision.status === 'denied') {
      return {
        ok: false,
        status: 'denied',
        request,
        policyDecision,
        logs: [],
        artifacts: {},
      }
    }

    const tempDir = await mkdtemp(path.join(this.tempRoot, this.tempPrefix))
    try {
      await this.writeMetadata(tempDir, input)
      const command = this.buildUvCommand(input)
      const result = await this.runUv(command.args, {
        cwd: tempDir,
        env: this.buildEnv(tempDir),
        timeoutMs: input.timeoutMs || this.timeoutMs,
        maxOutputBytes: input.maxOutputBytes || this.maxOutputBytes,
        networkPolicy: this.networkPolicy,
      })
      const stdout = redact(result.stdout?.toString?.() || result.stdout || '')
      const stderr = redact(result.stderr?.toString?.() || result.stderr || '')

      if (result.errorCode === 'ENOENT' || result.exitCode === 127) {
        return {
          ok: false,
          status: 'failed',
          error: {
            code: 'UV_MISSING',
            message: `uv binary not found: ${this.uvBinary}`,
          },
          request,
          policyDecision,
          logs: buildLogs(stdout, stderr),
          artifacts: {},
        }
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          status: 'failed',
          error: {
            code: 'UV_RESOLUTION_FAILED',
            exitCode: result.exitCode,
          },
          request,
          policyDecision,
          logs: buildLogs(stdout, stderr),
          artifacts: {},
        }
      }

      const runtimeResult = await this.buildRuntimeEnvironment(tempDir, input)
      if (runtimeResult.exitCode !== 0) {
        return {
          ok: false,
          status: 'failed',
          error: {
            code: 'UV_RUNTIME_BUILD_FAILED',
            exitCode: runtimeResult.exitCode,
          },
          request,
          policyDecision,
          logs: [
            ...buildLogs(stdout, stderr),
            ...buildLogs(
              redact(runtimeResult.stdout?.toString?.() || runtimeResult.stdout || ''),
              redact(runtimeResult.stderr?.toString?.() || runtimeResult.stderr || '')
            ),
          ],
          artifacts: {},
        }
      }

      const artifacts = await this.collectArtifacts(tempDir, input)
      const uvVersion = await this.detectUvVersion(tempDir)
      const runtime = describeRuntime(artifacts)
      const audit = buildAuditArtifacts({
        request,
        policyDecision,
        artifacts,
        uvVersion,
        runtime,
      })
      return {
        ok: true,
        status: 'resolved',
        request,
        policyDecision,
        uvVersion,
        command: {
          binary: this.uvBinary,
          args: command.args,
        },
        logs: buildLogs(stdout, stderr),
        artifacts,
        runtime,
        audit,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async detectUvVersion(tempDir) {
    const result = await this.runUv(['--version'], {
      cwd: tempDir,
      env: this.buildEnv(tempDir),
      timeoutMs: 10000,
      maxOutputBytes: 4096,
      networkPolicy: this.networkPolicy,
    })
    if (result.exitCode !== 0) return null
    return redact(result.stdout?.toString?.() || result.stdout || '').trim()
  }

  validateBrokerNetworkPolicy() {
    if (!BROKER_NETWORK_POLICIES.has(this.networkPolicy)) {
      return {
        code: 'BROKER_NETWORK_POLICY_DENIED',
        message:
          `Broker network policy "${this.networkPolicy}" is not allowed for dependency resolution.`,
      }
    }
    if (this.networkPolicy === 'package-index-proxy') {
      return validatePackageIndexProxyUrl(this.packageIndexProxyUrl)
    }
    return null
  }

  buildUvCommand(input = {}) {
    if (input.mode === 'script') {
      return { args: ['lock', '--script', input.scriptPath || 'script.py'] }
    }
    if (input.mode === 'project-lock') {
      return { args: ['lock'] }
    }
    if (input.mode === 'project-validate') {
      return { args: ['sync', '--locked', '--dry-run'] }
    }
    return { args: ['lock'] }
  }

  buildRuntimeCommand(input = {}) {
    if (input.mode === 'script') {
      return {
        args: [
          'sync',
          '--script',
          input.scriptPath || 'script.py',
          '--locked',
          '--link-mode',
          'copy',
        ],
      }
    }
    return {
      args: [
        'sync',
        '--locked',
        '--no-install-project',
        '--link-mode',
        'copy',
      ],
    }
  }

  async buildRuntimeEnvironment(tempDir, input = {}) {
    if (input.mode === 'script') {
      return this.buildScriptRuntimeEnvironment(tempDir, input)
    }
    const command = this.buildRuntimeCommand(input)
    return this.runUv(command.args, {
      cwd: tempDir,
      env: this.buildEnv(tempDir),
      timeoutMs: input.timeoutMs || this.timeoutMs,
      maxOutputBytes: input.maxOutputBytes || this.maxOutputBytes,
      networkPolicy: this.networkPolicy,
    })
  }

  async buildScriptRuntimeEnvironment(tempDir, input = {}) {
    const scriptPath = input.scriptPath || 'script.py'
    const commands = [
      [
        'export',
        '--script',
        scriptPath,
        '--format',
        'requirements-txt',
        '--output-file',
        'requirements.txt',
      ],
      ['venv', '.venv'],
      [
        'pip',
        'install',
        '--python',
        path.posix.join('.venv', 'bin', 'python'),
        '-r',
        'requirements.txt',
      ],
    ]
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    for (const args of commands) {
      const result = await this.runUv(args, {
        cwd: tempDir,
        env: this.buildEnv(tempDir),
        timeoutMs: input.timeoutMs || this.timeoutMs,
        maxOutputBytes: input.maxOutputBytes || this.maxOutputBytes,
        networkPolicy: this.networkPolicy,
      })
      stdout = Buffer.concat([
        stdout,
        Buffer.from(result.stdout?.toString?.() || result.stdout || ''),
      ])
      stderr = Buffer.concat([
        stderr,
        Buffer.from(result.stderr?.toString?.() || result.stderr || ''),
      ])
      if (result.exitCode !== 0) {
        return {
          ...result,
          stdout,
          stderr,
        }
      }
    }
    return {
      exitCode: 0,
      stdout,
      stderr,
    }
  }

  async writeMetadata(tempDir, input = {}) {
    for (const file of input.files || []) {
      const relativePath = normalizeRelativePath(file.path)
      const filePath = path.join(tempDir, relativePath)
      if (!isInside(tempDir, filePath)) {
        throw new Error(`Dependency metadata path escapes quarantine workspace: ${file.path}`)
      }
      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, String(file.content || ''), 'utf-8')
    }
  }

  async collectArtifacts(tempDir, input = {}) {
    const candidates = input.mode === 'script'
      ? [`${input.scriptPath || 'script.py'}.lock`]
      : ['uv.lock']
    const artifacts = {}
    for (const candidate of candidates) {
      const filePath = path.join(tempDir, normalizeRelativePath(candidate))
      if (!isInside(tempDir, filePath)) continue
      try {
        const content = await readFile(filePath, 'utf-8')
        artifacts[candidate] = {
          content,
          hash: `sha256:${sha256Hex(content)}`,
        }
      } catch {
        // uv may validate a pre-existing lock without writing a new artifact.
      }
    }
    await this.collectRuntimeArtifacts(tempDir, artifacts)
    return artifacts
  }

  async collectRuntimeArtifacts(tempDir, artifacts) {
    const venvDir = path.join(tempDir, '.venv')
    const sitePackagesDirs = await findSitePackagesDirs(venvDir)
    for (const sitePackagesDir of sitePackagesDirs) {
      const files = await listFilesRecursive(sitePackagesDir)
      for (const filePath of files) {
        const content = await readFile(filePath)
        const relativePath = path
          .posix
          .join(
            'site-packages',
            path.relative(sitePackagesDir, filePath).split(path.sep).join('/')
          )
        artifacts[relativePath] = {
          content,
          hash: `sha256:${sha256Hex(content)}`,
        }
      }
    }
  }

  buildEnv(tempDir) {
    return {
      ...filterSafeEnv(this.baseEnv),
      HOME: tempDir,
      UV_CACHE_DIR: path.join(tempDir, '.uv-cache'),
      UV_NO_PROGRESS: '1',
      UV_INDEX_STRATEGY: 'first-index',
      ...buildBrokerIndexEnv({
        networkPolicy: this.networkPolicy,
        packageIndexProxyUrl: this.packageIndexProxyUrl,
      }),
    }
  }

  runUv(args, options) {
    if (typeof this.runner === 'function') {
      return this.runner(this.uvBinary, args, options)
    }
    return this.runner.run(this.uvBinary, args, options)
  }
}

function validatePackageIndexProxyUrl(url) {
  const parsed = parsePackageIndexProxyUrl(url)
  if (!parsed) {
    return {
      code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED',
      message:
        'Package-index proxy broker policy requires an approved HTTP(S) simple index URL.',
    }
  }
  if (parsed.username || parsed.password) {
    return {
      code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED',
      message: 'Package-index proxy URL must not contain credentials.',
    }
  }
  if (
    parsed.hostname !== PACKAGE_INDEX_PROXY_HOST ||
    parsed.search ||
    parsed.hash ||
    (!parsed.pathname.endsWith('/simple') && !parsed.pathname.endsWith('/simple/'))
  ) {
    return {
      code: 'BROKER_PACKAGE_INDEX_PROXY_DENIED',
      message: 'Package-index proxy URL must point at a PEP 503 simple index.',
    }
  }
  return null
}

function parsePackageIndexProxyUrl(url) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (!PACKAGE_INDEX_PROXY_PROTOCOLS.has(parsed.protocol)) return null
    if (!parsed.hostname) return null
    return parsed
  } catch {
    return null
  }
}

function buildBrokerIndexEnv({ networkPolicy, packageIndexProxyUrl }) {
  if (networkPolicy !== 'package-index-proxy') return {}
  return {
    UV_INDEX_URL: packageIndexProxyUrl,
  }
}

async function findSitePackagesDirs(root) {
  const matches = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    if (path.basename(current) === 'site-packages') {
      matches.push(current)
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await walk(path.join(current, entry.name))
    }
  }
  await walk(root)
  return matches
}

async function listFilesRecursive(root) {
  const files = []
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(next)
      } else if (entry.isFile()) {
        files.push(next)
      }
    }
  }
  await walk(root)
  return files.sort()
}

function filterSafeEnv(env = {}) {
  const safeEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (SAFE_ENV_NAMES.has(name) || SAFE_UV_ENV_NAMES.has(name)) {
      safeEnv[name] = String(value)
    }
  }
  return safeEnv
}

function normalizeRequest(input = {}) {
  if (input.fingerprint) return input
  return buildDependencyRequest(input)
}

function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error('Dependency metadata path is required')
  }
  if (rawPath.includes('\\') || path.posix.isAbsolute(rawPath)) {
    throw new Error(`Dependency metadata path must be workspace-relative: ${rawPath}`)
  }
  const normalized = path.posix.normalize(rawPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Dependency metadata path escapes quarantine workspace: ${rawPath}`)
  }
  return normalized
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function buildLogs(stdout, stderr) {
  return [
    stdout ? { stream: 'stdout', content: stdout } : null,
    stderr ? { stream: 'stderr', content: stderr } : null,
  ].filter(Boolean)
}

function redact(value) {
  return String(value)
    .replace(SECRET_ASSIGNMENT_RE, `$1=${REDACTED}`)
    .replace(SECRET_RE, REDACTED)
}

function describeRuntime(artifacts = {}) {
  const hasSitePackages = Object.keys(artifacts).some(path =>
    path.startsWith('site-packages/')
  )
  return {
    sitePackages: hasSitePackages ? ['site-packages'] : [],
  }
}

function buildAuditArtifacts({ request, policyDecision, artifacts, uvVersion, runtime }) {
  const manifest = {
    requestFingerprint: request.fingerprint,
    sourceFiles: request.sourceFiles || [],
    requestedPackages: request.requestedPackages || [],
    requestedPythonVersion: request.requestedPythonVersion || null,
    requestedNetworkPolicy: request.requestedNetworkPolicy || 'none',
    policyDecision,
    artifactHashes: Object.fromEntries(
      Object.entries(artifacts || {}).map(([name, artifact]) => [name, artifact.hash])
    ),
    runtime,
    uvVersion,
  }
  const sbom = buildCycloneDxSbom({
    request,
    policyDecision,
    artifacts,
    uvVersion,
  })
  const manifestContent = `${stableStringify(manifest)}\n`
  const sbomContent = `${stableStringify(sbom)}\n`
  return {
    manifest,
    manifestHash: `sha256:${sha256Hex(manifestContent)}`,
    sbom,
    sbomHash: `sha256:${sha256Hex(sbomContent)}`,
  }
}

function buildCycloneDxSbom({ request, policyDecision, artifacts, uvVersion }) {
  const artifactHashes = Object.fromEntries(
    Object.entries(artifacts || {}).map(([name, artifact]) => [name, artifact.hash])
  )
  const components = (request.requestedPackages || []).map(pkg => {
    const version = versionFromSpecifier(pkg.specifier || pkg.raw || '')
    const purl = packageUrl(pkg)
    return {
      type: 'library',
      name: pkg.name,
      ...(version ? { version } : {}),
      ...(purl ? { purl } : {}),
      properties: [
        { name: 'resink:dependency:raw', value: pkg.raw || pkg.name },
        { name: 'resink:dependency:sourceHint', value: pkg.sourceHint || 'index' },
      ].filter(property => property.value != null && property.value !== ''),
    }
  })
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${deterministicUuid(request.fingerprint || '')}`,
    version: 1,
    metadata: {
      timestamp: new Date(0).toISOString(),
      tools: [{
        vendor: 'astral-sh',
        name: 'uv',
        version: uvVersion || 'unknown',
      }],
      component: {
        type: 'application',
        name: 'resink-python-environment',
        bomRef: request.fingerprint || 'resink-python-environment',
      },
      properties: [
        { name: 'resink:dependencyRequest:fingerprint', value: request.fingerprint || '' },
        { name: 'resink:dependencyRequest:scope', value: request.scope || '' },
        { name: 'resink:dependencyRequest:networkPolicy', value: request.requestedNetworkPolicy || 'none' },
        { name: 'resink:dependencyPolicy:status', value: policyDecision?.status || '' },
        { name: 'resink:dependencyPolicy:riskTier', value: policyDecision?.riskTier || '' },
      ].filter(property => property.value !== ''),
    },
    components,
    properties: [
      ...Object.entries(artifactHashes).map(([artifactPath, hash]) => ({
        name: `resink:artifact:${artifactPath}:hash`,
        value: hash,
      })),
    ],
  }
}

function versionFromSpecifier(specifier = '') {
  return /==\s*([^,\s]+)$/.exec(String(specifier).trim())?.[1] || undefined
}

function packageUrl(pkg = {}) {
  if (!pkg.name) return undefined
  const version = versionFromSpecifier(pkg.specifier || pkg.raw || '')
  return `pkg:pypi/${pkg.name}${version ? `@${version}` : ''}`
}

function deterministicUuid(value) {
  const hex = sha256Hex(value || 'resink-python-environment').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

function defaultRunner(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let outputLimited = false
    const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS)
    timer.unref?.()

    const append = (previous, chunk) => {
      const next = Buffer.concat([previous, chunk])
      if (next.length > maxOutputBytes) {
        outputLimited = true
        child.kill('SIGKILL')
        return next.subarray(0, maxOutputBytes)
      }
      return next
    }
    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({
        exitCode: error.code === 'ENOENT' ? 127 : 1,
        errorCode: error.code,
        stdout,
        stderr: Buffer.from(error.message),
        outputLimited,
      })
    })
    child.on('close', exitCode => {
      clearTimeout(timer)
      resolve({
        exitCode,
        stdout,
        stderr,
        outputLimited,
      })
    })
  })
}

export default QuarantineUvWorker
