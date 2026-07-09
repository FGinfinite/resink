import crypto from 'node:crypto'
import path from 'node:path'
import { SandboxPolicyError } from './SandboxErrors.js'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 300000
const MIN_OUTPUT_BYTES = 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const SAFE_ENV_NAMES = new Set([
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'PYTHON_ENV_ROOT',
  'PYTHONPATH',
  'PYTHONIOENCODING',
  'PYTHONUNBUFFERED',
  'TZ',
])
const RESERVED_RUNTIME_PATHS = ['.agent/python-envs']

const FORBIDDEN_EXECUTABLES = new Set([
  'apt',
  'apt-get',
  'bash',
  'chroot',
  'curl',
  'dd',
  'docker',
  'docker-compose',
  'mkfs',
  'mount',
  'nc',
  'netcat',
  'npx',
  'npm',
  'pnpm',
  'nsenter',
  'pip',
  'pip3',
  'pipx',
  'poetry',
  'scp',
  'service',
  'ssh',
  'sudo',
  'systemctl',
  'unshare',
  'wget',
])

const FORBIDDEN_PACKAGE_MANAGER_EXECUTABLES = new Set([
  'conda',
  'corepack',
  'mamba',
  'micromamba',
  'npm',
  'npx',
  'pnpm',
  'pip',
  'pip3',
  'pipx',
  'poetry',
  'uv',
  'uvx',
  'yarn',
])

const PYTHON_EXECUTABLES = new Set(['python', 'python3'])
const NODE_EXECUTABLES = new Set(['node', 'nodejs'])
const ENV_EXECUTABLES = new Set(['env'])
const UV_DENIED_SUBCOMMANDS = new Set([
  'add',
  'build',
  'export',
  'init',
  'lock',
  'pip',
  'python',
  'run',
  'sync',
  'tool',
  'venv',
])
const POETRY_DENIED_SUBCOMMANDS = new Set(['add', 'install'])
const CONDA_DENIED_SUBCOMMANDS = new Set(['create', 'env', 'install', 'run', 'update'])
const PYTHON_PACKAGE_MODULES = new Set(['ensurepip', 'pip', 'pipx', 'uv'])
const PACKAGE_MANAGER_WORD_RE = /\b(corepack|conda|mamba|micromamba|npm|npx|pip|pip3|pipx|pnpm|poetry|uv|uvx|yarn)\b/
const PACKAGE_MANAGER_SCRIPT_PATTERNS = [
  /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\([^)]*\b(?:corepack|conda|mamba|micromamba|npm|npx|pip|pip3|pipx|pnpm|poetry|uv|uvx|yarn)\b/s,
  /\bos\.(?:system|popen|spawn[lvpe]*|exec[lvpe]*)\s*\([^)]*\b(?:corepack|conda|mamba|micromamba|npm|npx|pip|pip3|pipx|pnpm|poetry|uv|uvx|yarn)\b/s,
  /\b(?:exec|execFile|spawn|spawnSync)\s*\([^)]*\b(?:corepack|conda|mamba|micromamba|npm|npx|pip|pip3|pipx|pnpm|poetry|uv|uvx|yarn)\b/s,
  /\bchild_process\b[\s\S]*\b(?:corepack|conda|mamba|micromamba|npm|npx|pip|pip3|pipx|pnpm|poetry|uv|uvx|yarn)\b/s,
  /\b(?:system|exec|spawn)\s*\([^)]*\b(?:corepack|conda|mamba|micromamba|npm|npx|pip|pip3|pipx|pnpm|poetry|uv|uvx|yarn)\b/s,
  /\b(?:pip|pip3|uv|uvx|pipx|poetry|conda|mamba|micromamba|npm|npx|pnpm|yarn|corepack)\s+(?:add|enable|install|run|sync|tool|venv|python|pip)\b/,
]
const SCRIPT_EXECUTABLES = new Set([
  'node',
  'nodejs',
  'perl',
  'python',
  'python3',
  'ruby',
  'sh',
])

const INLINE_SHELL_EXECUTABLES = new Set([
  'ash',
  'dash',
  'ksh',
  'sh',
  'zsh',
])

const FORBIDDEN_ARG_PATTERNS = [
  /^--privileged$/,
  /^--cap-add(?:=|$)/,
  /^--mount(?:=|$)/,
  /^--volume(?:=|$)/,
  /^-v$/,
  /^\/var\/run\/docker\.sock$/,
  /^\/dev\//,
]

const SECRET_VALUE_RE = /(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,})/g

export class SandboxEscapeGuard {
  validateCommandRequest(input = {}) {
    const command = this.validateArgv(input.command)
    const workdir = this.validateWorkspacePath(input.workdir || '.')
    const env = this.validateEnv(input.env || {})
    const timeoutMs = this.normalizeLimit(
      input.timeout_ms ?? input.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      'timeout_ms'
    )
    const maxOutputBytes = this.normalizeLimit(
      input.max_output_bytes ?? input.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      MIN_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
      'max_output_bytes'
    )

    return {
      command,
      workdir,
      env,
      timeoutMs,
      maxOutputBytes,
      commandId: crypto.randomUUID(),
      summary: this.safeCommandSummary(command, workdir),
    }
  }

  validateArgv(command) {
    if (!Array.isArray(command) || command.length === 0) {
      throw new SandboxPolicyError('Command must be a non-empty argv array', {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'empty-command',
      })
    }

    const argv = command.map(arg => {
      if (typeof arg !== 'string' || arg.length === 0) {
        throw new SandboxPolicyError('Command argv entries must be non-empty strings', {
          code: 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: 'invalid-argv',
        })
      }
      if (arg.includes('\0')) {
        throw new SandboxPolicyError('Command argv entries cannot contain NUL bytes', {
          code: 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: 'nul-byte',
        })
      }
      if (referencesReservedRuntimePath(arg)) {
        throw new SandboxPolicyError('Commands cannot modify approved Python environment runtime paths', {
          code: 'SANDBOX_PATH_POLICY_DENIED',
          reason: 'reserved-python-env-path',
          path: arg,
        })
      }
      return arg
    })

    const executable = path.posix.basename(argv[0])
    this.validatePackageManagerBypass(argv, executable)
    if (FORBIDDEN_EXECUTABLES.has(executable)) {
      throw new SandboxPolicyError(`Command "${executable}" is blocked by sandbox policy`, {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'forbidden-executable',
        executable,
      })
    }
    if (INLINE_SHELL_EXECUTABLES.has(executable) && argv.includes('-c')) {
      throw new SandboxPolicyError('Inline shell execution is blocked by sandbox policy', {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'inline-shell-blocked',
        executable,
      })
    }

    for (const arg of argv) {
      if (arg === 'rm -rf /' || arg.includes('rm -rf /')) {
        throw new SandboxPolicyError('Destructive root operations are blocked', {
          code: 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: 'destructive-root-operation',
        })
      }
      const pattern = FORBIDDEN_ARG_PATTERNS.find(re => re.test(arg))
      if (pattern) {
        throw new SandboxPolicyError('Privileged or host-mount command arguments are blocked', {
          code: 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: 'forbidden-argument',
          argument: arg,
        })
      }
    }

    return argv
  }

  validatePackageManagerBypass(argv, executable) {
    const denied = reason => {
      throw new SandboxPolicyError(
        'Python and project package installation is handled by the dependency broker',
        {
          code: 'PACKAGE_MANAGER_DENIED',
          reason,
          executable,
        }
      )
    }

    if (ENV_EXECUTABLES.has(executable)) {
      const nested = firstEnvCommand(argv.slice(1))
      if (nested) {
        this.validatePackageManagerBypass(nested, path.posix.basename(nested[0]))
      }
      return
    }

    if (FORBIDDEN_PACKAGE_MANAGER_EXECUTABLES.has(executable)) {
      if (['corepack', 'npm', 'npx', 'pnpm', 'yarn'].includes(executable)) {
        denied('node-package-manager-command')
      }
      if (executable === 'uvx') {
        denied('uv-package-manager-command')
      }
      if (executable === 'pipx') {
        denied('python-package-manager-command')
      }
      if (executable === 'uv') {
        const subcommand = firstNonOptionArg(argv.slice(1))
        if (!subcommand) {
          if (argv.includes('--version') || argv.includes('-V')) return
          denied('uv-package-manager-command')
        }
        if (subcommand === 'version') return
        if (UV_DENIED_SUBCOMMANDS.has(subcommand)) {
          denied('uv-package-manager-command')
        }
        return
      }
      if (executable === 'poetry') {
        const subcommand = firstNonOptionArg(argv.slice(1))
        if (!subcommand || POETRY_DENIED_SUBCOMMANDS.has(subcommand)) {
          denied('poetry-package-manager-command')
        }
        return
      }
      if (['conda', 'mamba', 'micromamba'].includes(executable)) {
        const subcommand = firstNonOptionArg(argv.slice(1))
        if (!subcommand || CONDA_DENIED_SUBCOMMANDS.has(subcommand)) {
          denied('conda-package-manager-command')
        }
        return
      }
      denied('python-package-manager-command')
    }

    if (PYTHON_EXECUTABLES.has(executable)) {
      const moduleName = pythonModuleArg(argv)
      if (moduleName && PYTHON_PACKAGE_MODULES.has(moduleName)) {
        denied('python-module-package-manager')
      }
      const inlineScript = pythonInlineScript(argv)
      if (
        inlineScript &&
        /\b(subprocess|os\.system|popen|spawn|exec)\b/.test(inlineScript) &&
        PACKAGE_MANAGER_WORD_RE.test(inlineScript)
      ) {
        denied('python-inline-package-manager-spawn')
      }
    }

    if (NODE_EXECUTABLES.has(executable) && argv[1] === '-e') {
      const script = argv.slice(2).join(' ')
      if (
        /\b(child_process|spawn|exec|execFile)\b/.test(script) &&
        PACKAGE_MANAGER_WORD_RE.test(script)
      ) {
        denied('node-inline-package-manager-spawn')
      }
    }
  }

  validateScriptContent(content, meta = {}) {
    const source = String(content || '')
    const match = PACKAGE_MANAGER_SCRIPT_PATTERNS.find(pattern => pattern.test(source))
    if (!match) return
    throw new SandboxPolicyError(
      'Workspace scripts cannot invoke package managers; use the dependency broker',
      {
        code: 'PACKAGE_MANAGER_DENIED',
        reason: 'workspace-script-package-manager',
        executable: meta.executable || null,
        path: meta.path || null,
      }
    )
  }

  scriptPathFromCommand(argv) {
    if (!Array.isArray(argv) || argv.length < 2) return null
    const executable = path.posix.basename(argv[0])
    if (!SCRIPT_EXECUTABLES.has(executable)) return null
    if (PYTHON_EXECUTABLES.has(executable)) {
      const inlineScript = pythonInlineScript(argv)
      const runpyPath = inlineScript.match(/\brunpy\.run_path\s*\(\s*['"]([^'"]+)['"]/)?.[1]
      if (runpyPath) return runpyPath
    }
    if (NODE_EXECUTABLES.has(executable) && argv[1] === '-e') {
      const script = argv.slice(2).join(' ')
      const requirePath = script.match(/\brequire\s*\(\s*['"]([^'"]+)['"]/)?.[1]
      if (requirePath) return requirePath
    }
    for (const arg of argv.slice(1)) {
      if (!arg || arg.startsWith('-')) continue
      if (arg === '-c' || arg === '--') return null
      if (
        arg.startsWith('.agent/scripts/') ||
        arg.startsWith('.skills/') ||
        arg.endsWith('.py') ||
        arg.endsWith('.js') ||
        arg.endsWith('.sh') ||
        arg.endsWith('.rb') ||
        arg.endsWith('.pl')
      ) {
        return arg
      }
      return null
    }
    return null
  }

  validateWorkspacePath(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') return '.'
    if (rawPath.includes('\\') || rawPath.includes('\0')) {
      throw new SandboxPolicyError('Workspace path contains forbidden characters', {
        code: 'SANDBOX_PATH_POLICY_DENIED',
        reason: 'forbidden-character',
        path: rawPath,
      })
    }
    if (path.posix.isAbsolute(rawPath)) {
      throw new SandboxPolicyError('Workspace path must be relative', {
        code: 'SANDBOX_PATH_POLICY_DENIED',
        reason: 'absolute-path',
        path: rawPath,
      })
    }
    const normalized = path.posix.normalize(rawPath)
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new SandboxPolicyError('Workspace path cannot escape /workspace', {
        code: 'SANDBOX_PATH_POLICY_DENIED',
        reason: 'path-escape',
        path: rawPath,
      })
    }
    if (isReservedRuntimePath(normalized)) {
      throw new SandboxPolicyError('Workspace path cannot target approved Python environment runtime paths', {
        code: 'SANDBOX_PATH_POLICY_DENIED',
        reason: 'reserved-python-env-path',
        path: rawPath,
      })
    }
    return normalized || '.'
  }

  validateEnv(env) {
    const safeEnv = {}
    for (const [name, value] of Object.entries(env || {})) {
      if (!SAFE_ENV_NAMES.has(name) || /^LD_|^DYLD_/.test(name) || name === 'PATH' || name === 'NODE_OPTIONS') {
        throw new SandboxPolicyError(`Environment variable "${name}" is blocked by sandbox policy`, {
          code: 'SANDBOX_ENV_POLICY_DENIED',
          reason: 'forbidden-env',
          name,
        })
      }
      if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
        throw new SandboxPolicyError(`Environment variable "${name}" has an invalid value`, {
          code: 'SANDBOX_ENV_POLICY_DENIED',
          reason: 'invalid-env-value',
          name,
        })
      }
      if (name === 'PYTHONPATH' && !isBrokerPythonPath(value)) {
        throw new SandboxPolicyError('PYTHONPATH must point at approved broker environments', {
          code: 'SANDBOX_ENV_POLICY_DENIED',
          reason: 'invalid-pythonpath',
          name,
        })
      }
      safeEnv[name] = value
    }
    return safeEnv
  }

  normalizeLimit(value, defaultValue, min, max, name) {
    if (value === undefined || value === null) return defaultValue
    const numeric = Number(value)
    if (!Number.isSafeInteger(numeric) || numeric < min || numeric > max) {
      throw new SandboxPolicyError(`Invalid ${name}; expected ${min}-${max}`, {
        code: 'SANDBOX_LIMIT_POLICY_DENIED',
        reason: 'invalid-limit',
        name,
        value,
      })
    }
    return numeric
  }

  safeCommandSummary(command, workdir = '.') {
    return `${workdir === '.' ? '/workspace' : `/workspace/${workdir}`}$ ${command
      .map(arg => this.redact(String(arg)))
      .join(' ')}`
  }

  redact(value = '') {
    return String(value).replace(SECRET_VALUE_RE, '[REDACTED]')
  }
}

function referencesReservedRuntimePath(value) {
  return RESERVED_RUNTIME_PATHS.some(reserved =>
    value === reserved ||
    value.startsWith(`${reserved}/`) ||
    value.includes(`/${reserved}/`) ||
    value.includes(` ${reserved}/`) ||
    value.includes(`"${reserved}/`) ||
    value.includes(`'${reserved}/`) ||
    value.includes(`(${reserved}/`)
  )
}

function isReservedRuntimePath(value) {
  return RESERVED_RUNTIME_PATHS.some(reserved =>
    value === reserved || value.startsWith(`${reserved}/`)
  )
}

function isBrokerPythonPath(value) {
  return String(value)
    .split(':')
    .every(entry =>
      /^\.agent\/python-envs\/pyenv_[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(entry)
    )
}

function firstNonOptionArg(args) {
  return args.find(arg => typeof arg === 'string' && arg && !arg.startsWith('-')) || ''
}

function firstEnvCommand(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (
      arg === '-i' ||
      arg === '-0' ||
      arg === '--ignore-environment' ||
      arg === '--null'
    ) {
      continue
    }
    if (arg === '-u' || arg === '--unset') {
      i++
      continue
    }
    if (arg.startsWith('-u') && arg.length > 2) {
      continue
    }
    if (arg.includes('=') && !arg.startsWith('/')) {
      continue
    }
    return args.slice(i)
  }
  return null
}

function pythonModuleArg(argv) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-m') return argv[i + 1] || null
    if (arg === '-c' || arg === '--') return null
    if (!arg.startsWith('-')) return null
  }
  return null
}

function pythonInlineScript(argv) {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '-c') return argv[i + 1] || ''
  }
  return ''
}

export default SandboxEscapeGuard
