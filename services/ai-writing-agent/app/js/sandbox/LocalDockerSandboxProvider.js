import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SandboxProvider, SandboxSession } from './SandboxProvider.js'
import {
  SandboxCommandError,
  SandboxNotFoundError,
  SandboxOutputLimitError,
  SandboxPathError,
  SandboxPolicyError,
  SandboxSetupError,
  SandboxTimeoutError,
} from './SandboxErrors.js'

const DEFAULT_IMAGE = 'alpine:3.20'
const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_FILE_COUNT = 5000
const DEFAULT_ROOT_PREFIX = 'overleaf-ai-sandbox-'
const DEFAULT_CONTAINER_PREFIX = 'overleaf-ai-sandbox-'
const RUNTIME_PYTHON_ENVS_DIR = 'runtime-python-envs'
const PROVIDER_LABEL = 'overleaf.ai.sandbox.provider=local-docker'
const MANAGED_LABEL = 'overleaf.ai.sandbox.managed=true'
const SESSION_ID_RE = /^[a-zA-Z0-9_.-]+$/
const ENVIRONMENT_ID_RE = /^pyenv_[a-zA-Z0-9_.-]+$/
const NETWORK_POLICIES = new Map([
  ['deny', 'none'],
  ['none', 'none'],
  ['default-deny', 'none'],
  ['development-permissive', 'bridge'],
  ['bridge', 'bridge'],
])

function createSpawnCommandRunner() {
  return {
    run(command, args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        let stdout = Buffer.alloc(0)
        let stderr = Buffer.alloc(0)
        let timedOut = false
        let outputLimited = false
        let timer = null

        const maxOutputBytes =
          options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

        function append(chunk, previous) {
          const next = Buffer.concat([previous, chunk])
          if (next.length > maxOutputBytes) {
            outputLimited = true
            child.kill('SIGKILL')
          }
          return next
        }

        child.stdout.on('data', (chunk) => {
          stdout = append(chunk, stdout)
        })
        child.stderr.on('data', (chunk) => {
          stderr = append(chunk, stderr)
        })
        child.on('error', reject)

        if (options.timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, options.timeoutMs)
          timer.unref?.()
        }

        child.on('close', (exitCode, signal) => {
          if (timer) clearTimeout(timer)
          resolve({
            exitCode,
            signal,
            stdout,
            stderr,
            timedOut,
            outputLimited,
          })
        })
      })
    },
  }
}

function normalizeWorkspacePath(rawPath = '.') {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new SandboxPathError(rawPath, 'path must be a non-empty string')
  }
  if (rawPath.includes('\\')) {
    throw new SandboxPathError(rawPath, 'backslashes are not allowed')
  }
  if (path.posix.isAbsolute(rawPath)) {
    throw new SandboxPathError(rawPath, 'absolute paths are not allowed')
  }
  const normalized = path.posix.normalize(rawPath)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new SandboxPathError(rawPath, '.. segments are not allowed')
  }
  return normalized === '.' ? '' : normalized
}

function resolveWorkspacePath(workspacePath, rawPath = '.') {
  const relativePath = normalizeWorkspacePath(rawPath)
  const absolutePath = path.resolve(workspacePath, relativePath)
  const relativeFromWorkspace = path.relative(workspacePath, absolutePath)
  if (
    relativeFromWorkspace.startsWith('..') ||
    path.isAbsolute(relativeFromWorkspace)
  ) {
    throw new SandboxPathError(rawPath, 'resolved path escapes workspace')
  }
  return { absolutePath, relativePath }
}

function resolveRuntimeEnvironmentPath(runtimeEnvironmentPath, environmentId, rawPath = '.') {
  if (!ENVIRONMENT_ID_RE.test(environmentId || '')) {
    throw new SandboxPathError(environmentId, 'invalid Python environment id')
  }
  const relativePath = normalizeWorkspacePath(rawPath)
  const absolutePath = path.resolve(runtimeEnvironmentPath, environmentId, relativePath)
  const environmentRoot = path.resolve(runtimeEnvironmentPath, environmentId)
  const relativeFromEnvironment = path.relative(environmentRoot, absolutePath)
  if (
    relativeFromEnvironment.startsWith('..') ||
    path.isAbsolute(relativeFromEnvironment)
  ) {
    throw new SandboxPathError(rawPath, 'resolved path escapes runtime environment')
  }
  return { absolutePath, relativePath }
}

async function assertRealPathInside(workspacePath, absolutePath, rawPath) {
  const [realWorkspacePath, realTargetPath] = await Promise.all([
    fs.realpath(workspacePath),
    fs.realpath(absolutePath),
  ])
  const relativeFromWorkspace = path.relative(realWorkspacePath, realTargetPath)
  if (
    relativeFromWorkspace.startsWith('..') ||
    path.isAbsolute(relativeFromWorkspace)
  ) {
    throw new SandboxPathError(rawPath, 'resolved real path escapes workspace')
  }
}

async function assertWriteTargetInside(workspacePath, absolutePath, rawPath) {
  const parentPath = path.dirname(absolutePath)
  await ensureDirectoryInside(workspacePath, parentPath, rawPath)
  if (await pathExists(absolutePath)) {
    await assertRealPathInside(workspacePath, absolutePath, rawPath)
  }
}

async function ensureDirectoryInside(workspacePath, targetDir, rawPath) {
  const realWorkspacePath = await fs.realpath(workspacePath)
  const relative = path.relative(workspacePath, targetDir)
  if (relative === '') return
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SandboxPathError(rawPath, 'resolved path escapes workspace')
  }
  let cursor = workspacePath
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    if (await pathExists(cursor)) {
      const realCursor = await fs.realpath(cursor)
      const relativeFromWorkspace = path.relative(realWorkspacePath, realCursor)
      if (
        relativeFromWorkspace.startsWith('..') ||
        path.isAbsolute(relativeFromWorkspace)
      ) {
        throw new SandboxPathError(rawPath, 'resolved real path escapes workspace')
      }
      continue
    }
    await fs.mkdir(cursor, { mode: 0o700 })
  }
}

function resolveSessionId(inputId) {
  const id = inputId || randomUUID()
  if (!SESSION_ID_RE.test(id)) {
    throw new SandboxSetupError('Invalid sandbox session id', {
      sessionId: id,
    })
  }
  return id
}

function normalizePositiveInteger(value, name) {
  if (value === undefined || value === null || value === '') return null
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new SandboxPolicyError(`Invalid sandbox ${name}`, {
      name,
      value,
    })
  }
  return numeric
}

function normalizePositiveNumber(value, name) {
  if (value === undefined || value === null || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new SandboxPolicyError(`Invalid sandbox ${name}`, {
      name,
      value,
    })
  }
  return numeric
}

function resolveNetworkName(policy = 'deny') {
  if (NETWORK_POLICIES.has(policy)) return NETWORK_POLICIES.get(policy)
  if (typeof policy === 'string' && policy.startsWith('docker-network:')) {
    const networkName = policy.slice('docker-network:'.length)
    if (/^[a-zA-Z0-9_.-]+$/.test(networkName)) return networkName
  }
  throw new SandboxPolicyError('Unsupported sandbox network policy', {
    networkPolicy: policy,
  })
}

function buildResourceArgs(limits) {
  const args = []
  if (limits.memoryBytes) args.push('--memory', String(limits.memoryBytes))
  if (limits.memorySwapBytes) {
    args.push('--memory-swap', String(limits.memorySwapBytes))
  }
  if (limits.cpuCount) args.push('--cpus', String(limits.cpuCount))
  if (limits.pidsLimit) args.push('--pids-limit', String(limits.pidsLimit))
  return args
}

function buildContainerLabels(id) {
  return [
    '--label',
    PROVIDER_LABEL,
    '--label',
    MANAGED_LABEL,
    '--label',
    `overleaf.ai.sandbox.session=${id}`,
  ]
}

function hasExpectedMounts(mounts = [], expected = {}) {
  const workspaceMount = mounts.find(mount => mount.Destination === '/workspace')
  const runtimeMount = mounts.find(
    mount => mount.Destination === '/workspace/.agent/python-envs'
  )
  return (
    workspaceMount?.Source === expected.workspacePath &&
    workspaceMount?.RW !== false &&
    runtimeMount?.Source === expected.runtimeEnvironmentPath &&
    runtimeMount?.RW === false
  )
}

function validateArtifactGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new SandboxPathError(glob, 'artifact glob must be a non-empty string')
  }
  if (
    glob.includes('\\') ||
    path.posix.isAbsolute(glob) ||
    glob.split('/').includes('..')
  ) {
    throw new SandboxPathError(glob, 'artifact glob is outside workspace scope')
  }
  return glob
}

function globToRegExp(glob) {
  const placeholder = '\u0000'
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, placeholder)
    .replace(/\*/g, '[^/]*')
    .replaceAll(placeholder, '.*')
  return new RegExp(`^${escaped}$`)
}

async function walkFiles(
  rootPath,
  basePath = rootPath,
  limit = DEFAULT_MAX_FILE_COUNT
) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name)
    const relativePath = path
      .relative(basePath, absolutePath)
      .split(path.sep)
      .join('/')
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath, basePath, limit)))
      if (files.length > limit) {
        throw new SandboxOutputLimitError(limit, {
          code: 'SANDBOX_FILE_COUNT_LIMIT',
          maxFileCount: limit,
        })
      }
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolutePath)
      files.push({
        path: relativePath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      })
      if (files.length > limit) {
        throw new SandboxOutputLimitError(limit, {
          code: 'SANDBOX_FILE_COUNT_LIMIT',
          maxFileCount: limit,
        })
      }
    }
  }
  return files
}

async function pathExists(absolutePath) {
  try {
    await fs.access(absolutePath)
    return true
  } catch {
    return false
  }
}

export class LocalDockerSandboxProvider extends SandboxProvider {
  constructor(options = {}) {
    super()
    this.image = options.image || DEFAULT_IMAGE
    this.dockerBin = options.dockerBin || 'docker'
    this.rootDir = options.rootDir
    this.dockerRootDir = options.dockerRootDir || options.hostRootDir || null
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
    this.maxFileCount = options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT
    this.networkPolicy = options.networkPolicy || 'deny'
    this.memoryBytes = normalizePositiveInteger(
      options.memoryBytes,
      'memoryBytes'
    )
    this.memorySwapBytes = normalizePositiveInteger(
      options.memorySwapBytes,
      'memorySwapBytes'
    )
    this.cpuCount = normalizePositiveNumber(options.cpuCount, 'cpuCount')
    this.pidsLimit = normalizePositiveInteger(options.pidsLimit, 'pidsLimit')
    this.commandRunner = options.commandRunner || createSpawnCommandRunner()
    this.sessions = new Map()
  }

  async ensureRootDir() {
    if (!this.rootDir) {
      this.rootDir = await fs.mkdtemp(
        path.join(os.tmpdir(), DEFAULT_ROOT_PREFIX)
      )
    }
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    return this.rootDir
  }


  resolveDockerWorkspacePath(workspacePath) {
    if (!this.dockerRootDir) return workspacePath
    const relativePath = path.relative(this.rootDir, workspacePath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new SandboxSetupError('Sandbox workspace path is outside the configured root', {
        workspacePath,
        rootDir: this.rootDir,
      })
    }
    return path.join(this.dockerRootDir, relativePath)
  }

  async createSession(input = {}) {
    const rootDir = await this.ensureRootDir()
    const id = resolveSessionId(input.id)
    const limits = this.resolveLimits(input.config || {})
    const workspacePath = path.join(rootDir, id, 'workspace')
    const runtimeEnvironmentPath = path.join(rootDir, id, RUNTIME_PYTHON_ENVS_DIR)
    const dockerWorkspacePath = this.resolveDockerWorkspacePath(workspacePath)
    const dockerRuntimeEnvironmentPath =
      this.resolveDockerWorkspacePath(runtimeEnvironmentPath)
    const containerName = `${DEFAULT_CONTAINER_PREFIX}${id}`
    const networkName = resolveNetworkName(
      input.networkPolicy || limits.networkPolicy
    )

    try {
      await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 })
      await fs.mkdir(runtimeEnvironmentPath, { recursive: true, mode: 0o700 })
      await this.runDocker([
        'create',
        '--name',
        containerName,
        ...buildContainerLabels(id),
        '--network',
        networkName,
        ...buildResourceArgs(limits),
        '--workdir',
        '/workspace',
        '--mount',
        `type=bind,src=${dockerWorkspacePath},dst=/workspace`,
        '--mount',
        `type=bind,src=${dockerRuntimeEnvironmentPath},dst=/workspace/.agent/python-envs,readonly`,
        this.image,
        'sh',
        '-c',
        'sleep infinity',
      ])
      await this.runDocker(['start', containerName])
    } catch (error) {
      await this.commandRunner
        .run(this.dockerBin, ['rm', '-f', containerName], {
          timeoutMs: this.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
        })
        .catch(() => {})
      await fs.rm(path.join(rootDir, id), { recursive: true, force: true })
      throw new SandboxSetupError('Failed to create local Docker sandbox', {
        sessionId: id,
        cause: error,
      })
    }

    const session = new LocalDockerSandboxSession({
      id,
      containerName,
      workspacePath,
      runtimeEnvironmentPath,
      provider: this,
      maxFileCount: limits.maxFileCount,
    })
    this.sessions.set(id, session)
    return session
  }

  resolveLimits(config = {}) {
    return {
      maxFileCount: normalizePositiveInteger(
        config.maxFileCount ?? this.maxFileCount,
        'maxFileCount'
      ),
      networkPolicy: config.networkPolicy || this.networkPolicy,
      memoryBytes: normalizePositiveInteger(
        config.memoryBytes ?? this.memoryBytes,
        'memoryBytes'
      ),
      memorySwapBytes: normalizePositiveInteger(
        config.memorySwapBytes ?? this.memorySwapBytes,
        'memorySwapBytes'
      ),
      cpuCount: normalizePositiveNumber(
        config.cpuCount ?? this.cpuCount,
        'cpuCount'
      ),
      pidsLimit: normalizePositiveInteger(
        config.pidsLimit ?? this.pidsLimit,
        'pidsLimit'
      ),
    }
  }

  async resumeSession(sessionId, persisted = {}) {
    const session = this.sessions.get(sessionId)
    if (session) return session

    const id = resolveSessionId(sessionId)
    const rootDir = await this.ensureRootDir()
    const workspacePath =
      persisted.workspacePath || path.join(rootDir, id, 'workspace')
    const runtimeEnvironmentPath =
      persisted.runtimeEnvironmentPath ||
      path.join(path.dirname(workspacePath), RUNTIME_PYTHON_ENVS_DIR)
    const containerName =
      persisted.containerName || `${DEFAULT_CONTAINER_PREFIX}${id}`
    if (!(await pathExists(workspacePath))) {
      throw new SandboxNotFoundError(sessionId)
    }
    const expectedMounts = {
      workspacePath,
      runtimeEnvironmentPath,
    }
    if (!(await this.containerMatches(containerName, expectedMounts))) {
      throw new SandboxNotFoundError(sessionId)
    }

    const restored = new LocalDockerSandboxSession({
      id,
      containerName,
      workspacePath,
      runtimeEnvironmentPath,
      provider: this,
      maxFileCount: this.maxFileCount,
    })
    this.sessions.set(id, restored)
    return restored
  }

  async containerMatches(containerName, expectedMounts = {}) {
    const result = await this.commandRunner.run(
      this.dockerBin,
      ['inspect', containerName],
      {
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      }
    )
    if (result.exitCode !== 0) return false
    let inspected
    try {
      inspected = JSON.parse(result.stdout?.toString('utf8') || '[]')
    } catch {
      return false
    }
    const container = Array.isArray(inspected) ? inspected[0] : null
    if (!container) return false
    return hasExpectedMounts(container.Mounts || [], {
      workspacePath: this.resolveDockerWorkspacePath(expectedMounts.workspacePath),
      runtimeEnvironmentPath:
        this.resolveDockerWorkspacePath(expectedMounts.runtimeEnvironmentPath),
    })
  }

  async destroySession(sessionId, persisted = {}) {
    let session = this.sessions.get(sessionId)
    if (!session && persisted.workspacePath) {
      session = await this.resumeSession(sessionId, persisted)
    }
    if (!session) throw new SandboxNotFoundError(sessionId)

    try {
      await this.runDocker(['rm', '-f', session.containerName], {
        timeoutMs: this.timeoutMs,
      })
    } finally {
      this.sessions.delete(session.id)
    }

    await this.removeWorkspaceDirectory(path.dirname(session.workspacePath))
  }

  async startupCleanup() {
    return this.cleanupOrphans({ includeActive: false })
  }

  async manualCleanup(options = {}) {
    return this.cleanupOrphans({
      includeActive: options.includeActive === true,
      removeWorkspaces: options.removeWorkspaces !== false,
    })
  }

  async cleanupOrphans(options = {}) {
    const includeActive = options.includeActive === true
    const removeWorkspaces = options.removeWorkspaces !== false
    const names = await this.listManagedContainerNames()
    const activeContainerNames = new Set(
      [...this.sessions.values()].map((session) => session.containerName)
    )
    const removedContainers = []

    for (const name of names) {
      if (!includeActive && activeContainerNames.has(name)) continue
      await this.runDocker(['rm', '-f', name]).catch(() => {})
      removedContainers.push(name)
    }

    const removedWorkspaces = removeWorkspaces
      ? await this.cleanupWorkspaceOrphans({ includeActive })
      : []

    return {
      removedContainers,
      removedWorkspaces,
    }
  }

  async listManagedContainerNames() {
    const result = await this.runDocker([
      'ps',
      '-a',
      '--filter',
      `label=${PROVIDER_LABEL}`,
      '--format',
      '{{.Names}}',
    ])
    return result.stdout
      .toString('utf-8')
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean)
  }

  async cleanupWorkspaceOrphans({ includeActive = false } = {}) {
    if (!this.rootDir || !(await pathExists(this.rootDir))) return []
    const activeWorkspaceParents = new Set(
      [...this.sessions.values()].map((session) =>
        path.dirname(session.workspacePath)
      )
    )
    const removed = []
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const absolutePath = path.join(this.rootDir, entry.name)
      if (!includeActive && activeWorkspaceParents.has(absolutePath)) continue
      await this.removeWorkspaceDirectory(absolutePath)
      removed.push(absolutePath)
    }
    return removed
  }


  async removeWorkspaceDirectory(absolutePath) {
    try {
      await fs.rm(absolutePath, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error
    }

    await this.runDocker([
      'run',
      '--rm',
      '-v',
      `${this.resolveDockerWorkspacePath(absolutePath)}:/cleanup-target`,
      'busybox:1.36',
      'sh',
      '-c',
      'rm -rf /cleanup-target/* /cleanup-target/.[!.]* /cleanup-target/..?*',
    ], { timeoutMs: this.timeoutMs })
    await fs.rm(absolutePath, { recursive: true, force: true })
  }

  async runDocker(args, options = {}) {
    const result = await this.commandRunner.run(this.dockerBin, args, {
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? this.maxOutputBytes,
    })
    if (result.timedOut) {
      throw new SandboxTimeoutError(options.timeoutMs ?? this.timeoutMs, {
        command: this.dockerBin,
        args,
      })
    }
    if (result.outputLimited) {
      throw new SandboxOutputLimitError(
        options.maxOutputBytes ?? this.maxOutputBytes,
        { command: this.dockerBin, args }
      )
    }
    if (result.exitCode !== 0) {
      throw new SandboxCommandError('Docker command failed', {
        command: this.dockerBin,
        args,
        exitCode: result.exitCode,
        stderr: result.stderr?.toString('utf-8') || '',
      })
    }
    return result
  }
}

export class LocalDockerSandboxSession extends SandboxSession {
  constructor({
    id,
    containerName,
    workspacePath,
    runtimeEnvironmentPath,
    provider,
    maxFileCount,
  }) {
    super()
    this.id = id
    this.containerName = containerName
    this.workspacePath = workspacePath
    this.runtimeEnvironmentPath = runtimeEnvironmentPath
    this.provider = provider
    this.maxFileCount = maxFileCount ?? provider.maxFileCount
    this.capabilities = {
      immutableRuntimeEnvironmentMount: true,
    }
  }

  async *run(input) {
    const command = normalizeCommandInput(input)
    if (command.length === 0) {
      throw new SandboxCommandError(
        'Sandbox command must be a non-empty array or command string'
      )
    }
    const workdir = normalizeContainerWorkdir(input.workdir)
    const timeoutMs = input.timeoutMs ?? this.provider.timeoutMs
    const maxOutputBytes = input.maxOutputBytes ?? this.provider.maxOutputBytes
    const envArgs = buildExecEnvArgs(input.env)

    yield {
      type: 'start',
      sessionId: this.id,
      command,
    }

    const args = [
      'exec',
      '--workdir',
      workdir,
      ...envArgs,
      this.containerName,
      ...command,
    ]
    const result = await this.provider.commandRunner.run(
      this.provider.dockerBin,
      args,
      { timeoutMs, maxOutputBytes }
    )

    if (result.stdout?.length) {
      yield {
        type: 'stdout',
        data: result.stdout.toString('utf-8'),
      }
    }
    if (result.stderr?.length) {
      yield {
        type: 'stderr',
        data: result.stderr.toString('utf-8'),
      }
    }

    if (result.timedOut) {
      throw new SandboxTimeoutError(timeoutMs, {
        sessionId: this.id,
        command,
      })
    }
    if (result.outputLimited) {
      throw new SandboxOutputLimitError(maxOutputBytes, {
        sessionId: this.id,
        command,
      })
    }

    yield {
      type: 'exit',
      exitCode: result.exitCode,
      signal: result.signal ?? null,
    }
  }

  async readFile(rawPath) {
    const { absolutePath } = resolveWorkspacePath(this.workspacePath, rawPath)
    await assertRealPathInside(this.workspacePath, absolutePath, rawPath)
    return fs.readFile(absolutePath)
  }

  async writeFile(rawPath, content) {
    const { absolutePath } = resolveWorkspacePath(this.workspacePath, rawPath)
    await assertWriteTargetInside(this.workspacePath, absolutePath, rawPath)
    await fs.writeFile(absolutePath, content)
  }

  async writeRuntimeEnvironmentFile(environmentId, rawPath, content) {
    const { absolutePath } = resolveRuntimeEnvironmentPath(
      this.runtimeEnvironmentPath,
      environmentId,
      rawPath
    )
    await assertWriteTargetInside(
      this.runtimeEnvironmentPath,
      absolutePath,
      rawPath
    )
    await fs.writeFile(absolutePath, content)
  }

  async listFiles(rawPath = '.') {
    const { absolutePath } = resolveWorkspacePath(this.workspacePath, rawPath)
    if (!(await pathExists(absolutePath))) return []
    await assertRealPathInside(this.workspacePath, absolutePath, rawPath)
    const stat = await fs.stat(absolutePath)
    if (stat.isFile()) {
      return [
        {
          path: normalizeWorkspacePath(rawPath),
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        },
      ]
    }
    const files = await walkFiles(
      absolutePath,
      this.workspacePath,
      this.maxFileCount
    )
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  async collectArtifacts(globs = []) {
    const patterns = globs.map(validateArtifactGlob).map(globToRegExp)
    const files = await this.listFiles('.')
    const artifacts = []

    for (const file of files) {
      if (!patterns.some((pattern) => pattern.test(file.path))) continue
      if (file.size > this.provider.maxArtifactBytes) {
        throw new SandboxOutputLimitError(this.provider.maxArtifactBytes, {
          path: file.path,
          size: file.size,
        })
      }
      const { absolutePath } = resolveWorkspacePath(
        this.workspacePath,
        file.path
      )
      artifacts.push({
        path: file.path,
        size: file.size,
        content: await fs.readFile(absolutePath),
      })
    }

    return artifacts
  }
}

export default LocalDockerSandboxProvider

function normalizeCommandInput(input = {}) {
  if (Array.isArray(input.command)) {
    return input.command
  }
  if (typeof input.command === 'string' && input.command.length > 0) {
    return [input.command, ...(input.args || [])]
  }
  return []
}

function normalizeContainerWorkdir(rawPath = '.') {
  const relativePath = normalizeWorkspacePath(rawPath)
  return relativePath ? path.posix.join('/workspace', relativePath) : '/workspace'
}

function buildExecEnvArgs(env = {}) {
  const args = []
  for (const [name, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new SandboxCommandError(
        'Invalid sandbox environment variable name',
        {
          name,
        }
      )
    }
    args.push('--env', `${name}=${value}`)
  }
  return args
}
