import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { SandboxProvider, SandboxSession } from './SandboxProvider.js'
import {
  SandboxCommandError,
  SandboxNotFoundError,
  SandboxOutputLimitError,
  SandboxPathError,
  SandboxSetupError,
  SandboxTimeoutError,
} from './SandboxErrors.js'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
const DEFAULT_MAX_FILE_COUNT = 5000
const DEFAULT_REMOTE_WORKSPACE = '/workspace'
const DEFAULT_ROOT_PREFIX = 'overleaf-ai-e2b-'
const SESSION_ID_RE = /^[a-zA-Z0-9_.-]+$/

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

function normalizeRemotePath(remoteWorkspacePath, rawPath = '.') {
  const relativePath = normalizeWorkspacePath(rawPath)
  return path.posix.join(remoteWorkspacePath, relativePath)
}

function normalizeCommandInput(input = {}) {
  if (Array.isArray(input.command)) return input.command
  if (typeof input.command === 'string' && input.command.length > 0) {
    return [input.command, ...(input.args || [])]
  }
  return []
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function buildShellCommand(command, env = {}) {
  const assignments = Object.entries(env || {}).map(
    ([name, value]) => `${validateEnvName(name)}=${shellQuote(value)}`
  )
  return [...assignments, ...command.map(shellQuote)].join(' ')
}

function validateEnvName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new SandboxCommandError(
      'Invalid sandbox environment variable name',
      { name }
    )
  }
  return name
}

function normalizePositiveInteger(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return defaultValue
  return numeric
}

function enforceOutputLimit(result, maxOutputBytes) {
  const stdoutBytes = Buffer.byteLength(String(result.stdout || ''))
  const stderrBytes = Buffer.byteLength(String(result.stderr || ''))
  if (stdoutBytes + stderrBytes > maxOutputBytes) {
    throw new SandboxOutputLimitError(maxOutputBytes)
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

async function pathExists(absolutePath) {
  try {
    await fs.access(absolutePath)
    return true
  } catch {
    return false
  }
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
    } else if (entry.isFile()) {
      const stat = await fs.stat(absolutePath)
      files.push({
        path: relativePath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      })
    }
    if (files.length > limit) {
      throw new SandboxOutputLimitError(limit, {
        code: 'SANDBOX_FILE_COUNT_LIMIT',
        maxFileCount: limit,
      })
    }
  }
  return files
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

async function defaultSdkFactory() {
  try {
    return await import('e2b')
  } catch (error) {
    throw new SandboxSetupError(
      'E2B SDK is not installed. Install the e2b package to use the e2b provider.',
      { cause: error }
    )
  }
}

export class E2BSandboxProvider extends SandboxProvider {
  constructor(options = {}) {
    super()
    this.template = options.template || null
    this.apiKey = options.apiKey || process.env.E2B_API_KEY || null
    this.rootDir = options.rootDir
    this.remoteWorkspacePath =
      options.remoteWorkspacePath || DEFAULT_REMOTE_WORKSPACE
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES
    this.maxFileCount = options.maxFileCount ?? DEFAULT_MAX_FILE_COUNT
    this.sdkFactory = options.sdkFactory || defaultSdkFactory
    this.sessions = new Map()
  }

  async ensureRootDir() {
    if (!this.rootDir) {
      this.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), DEFAULT_ROOT_PREFIX))
    }
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    return this.rootDir
  }

  async createSession(input = {}) {
    if (!this.apiKey) {
      throw new SandboxSetupError('E2B_API_KEY is required for e2b provider')
    }
    const id = resolveSessionId(input.id)
    const rootDir = await this.ensureRootDir()
    const workspacePath = path.join(rootDir, id, 'workspace')
    await fs.mkdir(workspacePath, { recursive: true, mode: 0o700 })

    try {
      const sdk = await this.sdkFactory()
      const sandbox = await this.createE2BSandbox(sdk)
      const remoteWorkspacePath = input.remoteWorkspacePath ||
        this.remoteWorkspacePath
      const session = new E2BSandboxSession({
        id,
        sandbox,
        workspacePath,
        remoteWorkspacePath,
        provider: this,
        maxFileCount: normalizePositiveInteger(
          input.config?.maxFileCount,
          this.maxFileCount
        ),
      })
      await session.ensureRemoteWorkspace()
      this.sessions.set(id, session)
      return session
    } catch (error) {
      await fs.rm(path.dirname(workspacePath), { recursive: true, force: true })
      if (error instanceof SandboxSetupError) throw error
      throw new SandboxSetupError('Failed to create E2B sandbox', {
        sessionId: id,
        cause: error,
      })
    }
  }

  async createE2BSandbox(sdk) {
    const { Sandbox } = sdk
    if (!Sandbox?.create) {
      throw new SandboxSetupError('E2B SDK does not expose Sandbox.create')
    }
    const options = {
      apiKey: this.apiKey,
      timeoutMs: this.timeoutMs,
    }
    return this.template
      ? Sandbox.create(this.template, options)
      : Sandbox.create(options)
  }

  async resumeSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new SandboxNotFoundError(sessionId)
    return session
  }

  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new SandboxNotFoundError(sessionId)
    try {
      await session.sandbox.kill?.()
    } finally {
      this.sessions.delete(sessionId)
      await fs.rm(path.dirname(session.workspacePath), {
        recursive: true,
        force: true,
      })
    }
  }
}

export class E2BSandboxSession extends SandboxSession {
  constructor({
    id,
    sandbox,
    workspacePath,
    remoteWorkspacePath,
    provider,
    maxFileCount,
  }) {
    super()
    this.id = id
    this.sandbox = sandbox
    this.workspacePath = workspacePath
    this.remoteWorkspacePath = remoteWorkspacePath
    this.provider = provider
    this.maxFileCount = maxFileCount ?? provider.maxFileCount
    this.capabilities = {
      immutableRuntimeEnvironmentMount: false,
    }
  }

  async ensureRemoteWorkspace() {
    await this.sandbox.commands.run(
      `mkdir -p ${shellQuote(this.remoteWorkspacePath)}`,
      { timeoutMs: this.provider.timeoutMs }
    )
  }

  async syncLocalToRemote() {
    await this.sandbox.commands.run(
      `find ${shellQuote(this.remoteWorkspacePath)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
      { timeoutMs: this.provider.timeoutMs }
    )
    const files = await this.listFiles('.')
    if (files.length === 0) return
    const writes = []
    for (const file of files) {
      const { absolutePath } = resolveWorkspacePath(this.workspacePath, file.path)
      writes.push({
        path: normalizeRemotePath(this.remoteWorkspacePath, file.path),
        data: await fs.readFile(absolutePath),
      })
    }
    await this.sandbox.files.write(writes)
  }

  async syncRemoteToLocal() {
    const findCommand = [
      'find',
      this.remoteWorkspacePath,
      '-type',
      'f',
      '-print',
    ]
    const result = await this.sandbox.commands.run(
      buildShellCommand(findCommand),
      { timeoutMs: this.provider.timeoutMs }
    )
    this.assertCommandResult(result, findCommand)
    await fs.rm(this.workspacePath, { recursive: true, force: true })
    await fs.mkdir(this.workspacePath, { recursive: true, mode: 0o700 })
    const remoteFiles = String(result.stdout || '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    if (remoteFiles.length > this.maxFileCount) {
      throw new SandboxOutputLimitError(this.maxFileCount, {
        code: 'SANDBOX_FILE_COUNT_LIMIT',
        maxFileCount: this.maxFileCount,
      })
    }
    for (const remotePath of remoteFiles) {
      const relativePath = path.posix.relative(this.remoteWorkspacePath, remotePath)
      if (relativePath.startsWith('..')) continue
      const content = await this.sandbox.files.read(remotePath)
      await this.writeFile(relativePath, content)
    }
  }

  async *run(input = {}) {
    const command = normalizeCommandInput(input)
    if (command.length === 0) {
      throw new SandboxCommandError(
        'Sandbox command must be a non-empty array or command string'
      )
    }
    const remoteWorkdir = normalizeRemotePath(
      this.remoteWorkspacePath,
      input.workdir || '.'
    )
    await this.syncLocalToRemote()

    yield {
      type: 'start',
      sessionId: this.id,
      command,
    }

    const shellCommand = `cd ${shellQuote(remoteWorkdir)} && ${buildShellCommand(
      command,
      input.env
    )}`
    const result = await this.sandbox.commands.run(shellCommand, {
      timeoutMs: input.timeoutMs ?? this.provider.timeoutMs,
    })

    if (result.stdout) yield { type: 'stdout', data: String(result.stdout) }
    if (result.stderr) yield { type: 'stderr', data: String(result.stderr) }
    enforceOutputLimit(
      result,
      input.maxOutputBytes ?? this.provider.maxOutputBytes
    )
    this.assertCommandResult(result, command)
    await this.syncRemoteToLocal()

    yield {
      type: 'exit',
      exitCode: result.exitCode ?? 0,
      signal: null,
    }
  }

  assertCommandResult(result, command) {
    if (result.error) {
      throw new SandboxCommandError('E2B command failed', {
        sessionId: this.id,
        command,
        stderr: String(result.stderr || result.error),
      })
    }
    if (result.timedOut) {
      throw new SandboxTimeoutError(this.provider.timeoutMs, {
        sessionId: this.id,
        command,
      })
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
    return (await walkFiles(absolutePath, this.workspacePath, this.maxFileCount))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  async collectArtifacts(globs = []) {
    const patterns = globs.map(validateArtifactGlob).map(globToRegExp)
    const files = await this.listFiles('.')
    const artifacts = []
    for (const file of files) {
      if (!patterns.some(pattern => pattern.test(file.path))) continue
      if (file.size > this.provider.maxArtifactBytes) {
        throw new SandboxOutputLimitError(this.provider.maxArtifactBytes, {
          path: file.path,
          size: file.size,
        })
      }
      artifacts.push({
        path: file.path,
        size: file.size,
        content: await this.readFile(file.path),
      })
    }
    return artifacts
  }
}

export default E2BSandboxProvider
