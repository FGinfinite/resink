import { spawn } from 'node:child_process'
import path from 'node:path'
import { lstat, realpath } from 'node:fs/promises'

const DEFAULT_IMAGE = 'resink-uv-broker:dev'
const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024
const BROKER_WORKSPACE = '/broker-workspace'
const NETWORK_POLICIES = new Map([
  ['restricted', 'none'],
])
const NETWORK_NAME_RE = /^[a-zA-Z0-9_.-]+$/
const PACKAGE_INDEX_PROXY_NETWORK_RE = /^resink-broker-proxy-[a-zA-Z0-9_.-]+$/
const PACKAGE_INDEX_PROXY_HOST = 'pypi-proxy'
const QUARANTINE_WORKSPACE_BASENAME_RE = /^resink-uv-broker-[a-zA-Z0-9_.-]+$/
const SAFE_ENV_NAMES = new Set([
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'TZ',
  'UV_CACHE_DIR',
  'UV_INDEX_STRATEGY',
  'UV_NO_PROGRESS',
])
const PACKAGE_INDEX_PROXY_PROTOCOLS = new Set(['http:', 'https:'])

export class DockerUvBrokerRunner {
  constructor(options = {}) {
    this.dockerBin = options.dockerBin || 'docker'
    this.image = options.image || DEFAULT_IMAGE
    this.networkPolicy = options.networkPolicy || 'restricted'
    this.packageIndexProxyNetwork = options.packageIndexProxyNetwork || null
    this.workspaceRoot = options.workspaceRoot || '/tmp'
    this.workspaceHostRoot = options.workspaceHostRoot || null
    this.uid = options.uid || process.getuid?.() || 1000
    this.gid = options.gid || process.getgid?.() || 1000
    this.commandRunner = options.commandRunner || createSpawnCommandRunner()
  }

  async run(command, args = [], options = {}) {
    const networkPolicy = options.networkPolicy || this.networkPolicy
    const networkName = this.resolveNetworkName(networkPolicy)
    const workspace = await this.resolveWorkspace(options.cwd)
    this.validateEnv({ networkPolicy, env: options.env || {} })
    const dockerArgs = [
      'run',
      '--rm',
      '--network',
      networkName,
      '--user',
      `${this.uid}:${this.gid}`,
      '--workdir',
      BROKER_WORKSPACE,
      '--mount',
      `type=bind,src=${workspace.hostPath},dst=${BROKER_WORKSPACE}`,
      ...buildEnvArgs({
        env: options.env || {},
        networkPolicy,
      }),
      this.image,
      command,
      ...args,
    ]
    return this.commandRunner.run(this.dockerBin, dockerArgs, {
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES,
    })
  }

  async resolveWorkspace(cwd) {
    if (!QUARANTINE_WORKSPACE_BASENAME_RE.test(path.basename(cwd))) {
      throw workspaceDenied()
    }
    const stat = await lstat(cwd).catch(() => null)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw workspaceDenied()
    }
    const canonicalPath = await realpath(cwd)
    const canonicalRoot = await realpath(this.workspaceRoot).catch(() => null)
    if (
      !canonicalRoot ||
      canonicalPath !== cwd ||
      !isInside(canonicalRoot, canonicalPath) ||
      !QUARANTINE_WORKSPACE_BASENAME_RE.test(path.basename(canonicalPath))
    ) {
      throw workspaceDenied()
    }
    const relativeWorkspace = path.relative(canonicalRoot, canonicalPath)
    const hostPath = await this.resolveHostWorkspacePath(relativeWorkspace, canonicalPath)
    return {
      containerPath: cwd,
      hostPath,
    }
  }

  async resolveHostWorkspacePath(relativeWorkspace, fallbackPath) {
    if (!this.workspaceHostRoot) return fallbackPath
    if (
      !path.isAbsolute(this.workspaceHostRoot) ||
      this.workspaceHostRoot.includes(',') ||
      this.workspaceHostRoot.includes('\n')
    ) {
      throw workspaceDenied()
    }
    const hostPath = path.join(this.workspaceHostRoot, relativeWorkspace)
    if (
      !isInside(this.workspaceHostRoot, hostPath) ||
      !QUARANTINE_WORKSPACE_BASENAME_RE.test(path.basename(hostPath))
    ) {
      throw workspaceDenied()
    }
    return hostPath
  }

  resolveNetworkName(networkPolicy) {
    if (NETWORK_POLICIES.has(networkPolicy)) {
      return NETWORK_POLICIES.get(networkPolicy)
    }
    if (networkPolicy === 'package-index-proxy') {
      if (!isApprovedPackageIndexProxyNetwork(this.packageIndexProxyNetwork)) {
        const error = new Error(
          'Package-index proxy broker policy requires an approved Docker network'
        )
        error.code = 'BROKER_DOCKER_NETWORK_DENIED'
        throw error
      }
      return this.packageIndexProxyNetwork
    }
    const error = new Error(`Unsupported broker Docker network policy: ${networkPolicy}`)
    error.code = 'BROKER_DOCKER_NETWORK_DENIED'
    throw error
  }

  validateEnv({ networkPolicy, env }) {
    if (networkPolicy !== 'package-index-proxy') return
    const proxyUrlError = validatePackageIndexProxyUrl(env.UV_INDEX_URL)
    if (proxyUrlError) throw proxyUrlError
  }
}

function workspaceDenied() {
  const error = new Error('Broker Docker runner requires a quarantine workspace')
  error.code = 'BROKER_WORKSPACE_DENIED'
  return error
}

function buildEnvArgs({ env, networkPolicy }) {
  return Object
    .entries(env)
    .filter(([name]) => isSafeEnvName({ name, networkPolicy }))
    .flatMap(([name, value]) => [
      '--env',
      `${name}=${mapBrokerWorkspacePath(String(value))}`,
    ])
}

function isSafeEnvName({ name, networkPolicy }) {
  if (SAFE_ENV_NAMES.has(name)) return true
  return networkPolicy === 'package-index-proxy' && name === 'UV_INDEX_URL'
}

function validatePackageIndexProxyUrl(url) {
  let parsed
  try {
    parsed = url ? new URL(String(url)) : null
  } catch {
    parsed = null
  }
  if (
    !parsed ||
    !PACKAGE_INDEX_PROXY_PROTOCOLS.has(parsed.protocol) ||
    !parsed.hostname ||
    parsed.hostname !== PACKAGE_INDEX_PROXY_HOST ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (!parsed.pathname.endsWith('/simple') && !parsed.pathname.endsWith('/simple/'))
  ) {
    const error = new Error(
      'Package-index proxy policy requires an approved HTTP(S) simple index URL without credentials'
    )
    error.code = 'BROKER_PACKAGE_INDEX_PROXY_DENIED'
    return error
  }
  return null
}

function isApprovedPackageIndexProxyNetwork(networkName) {
  if (!NETWORK_NAME_RE.test(networkName || '')) return false
  return PACKAGE_INDEX_PROXY_NETWORK_RE.test(networkName)
}

function mapBrokerWorkspacePath(value) {
  const tempRoot = /^.*\/resink-uv-broker-[a-zA-Z0-9_.-]+/.exec(value)?.[0]
  if (!tempRoot) return value
  return value.replaceAll(tempRoot, BROKER_WORKSPACE)
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function createSpawnCommandRunner() {
  return {
    run(command, args, options = {}) {
      return new Promise(resolve => {
        const child = spawn(command, args, {
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
    },
  }
}

export default DockerUvBrokerRunner
