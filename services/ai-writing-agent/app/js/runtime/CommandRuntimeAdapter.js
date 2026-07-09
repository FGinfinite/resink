import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { AgentRuntimeAdapter, AgentRuntimeEventTypes } from './AgentRuntimeAdapter.js'
import {
  RuntimeAuthError,
  RuntimeErrorCodes,
  RuntimeExecutionError,
  RuntimeInvalidInputError,
  RuntimeMissingBinaryError,
} from './RuntimeErrors.js'

const REDACTED = '[redacted]'
const SECRET_NAME_RE = /(?:api[_-]?key|token|secret|password|credential|authorization)/i
const SECRET_ASSIGNMENT_RE =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)[A-Z0-9_]*)=([^\s]+)/gi
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const SK_PREFIX_RE = /\b(?:sk|pk|sess|key)-[A-Za-z0-9._-]{8,}\b/gi

function defaultRunner(command, options) {
  return spawn(command, options.args || [], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: options.signal,
  })
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === 'function'
}

export function collectCredentialValues(env) {
  const values = new Set()
  for (const [name, value] of Object.entries(env || {})) {
    if (SECRET_NAME_RE.test(name) && value) {
      values.add(String(value))
    }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

export function redactRuntimeValue(value, credentialValues = []) {
  if (value == null) return value
  let text = String(value)
  for (const secret of credentialValues) {
    if (secret) {
      text = text.split(secret).join(REDACTED)
    }
  }
  return text
    .replace(SECRET_ASSIGNMENT_RE, `$1=${REDACTED}`)
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(SK_PREFIX_RE, REDACTED)
}

export function redactObject(value, credentialValues) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value !== 'object') {
    return redactRuntimeValue(value, credentialValues)
  }
  if (Array.isArray(value)) {
    return value.map(item => redactObject(item, credentialValues))
  }
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_NAME_RE.test(key)
      ? REDACTED
      : redactObject(entry, credentialValues)
  }
  return output
}

export function envForProcess(baseEnv, credentialEnv, extraEnv) {
  return {
    ...baseEnv,
    ...extraEnv,
    ...credentialEnv,
  }
}

export class CommandRuntimeAdapter extends AgentRuntimeAdapter {
  constructor(options = {}) {
    super({ id: options.id, displayName: options.displayName })
    this.binary = options.binary
    this.runArgs = options.runArgs || []
    this.detectArgs = options.detectArgs || ['--version']
    this.baseEnv = options.baseEnv || process.env
    this.runner = options.runner || defaultRunner
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
    this.maxEventBytes = options.maxEventBytes ?? 64 * 1024
    this.missingBinaryMessage =
      options.missingBinaryMessage ||
      `${this.displayName} binary not found: ${this.binary}`
    this.authFailureLabel = options.authFailureLabel || this.displayName
    this.running = new Map()
  }

  async detect(input = {}) {
    const credentialEnv = input.credentials?.env || input.credentialEnv || {}
    const extraEnv = input.env || {}
    const credentialValues = collectCredentialValues(credentialEnv)
    const result = await this.runCommand({
      args: input.detectArgs || this.detectArgs,
      cwd: input.cwd,
      env: envForProcess(this.baseEnv, credentialEnv, extraEnv),
      timeoutMs: input.timeoutMs ?? 15000,
      credentialValues,
    })

    if (result.errorCode === 'ENOENT') {
      return {
        ok: false,
        adapter: this.id,
        reason: RuntimeErrorCodes.MISSING_BINARY,
        message: this.missingBinaryMessage,
      }
    }

    if (result.exitCode !== 0) {
      const error = this.classifyFailure(result, credentialValues)
      return {
        ok: false,
        adapter: this.id,
        reason: error.code,
        message: error.message,
      }
    }

    return {
      ok: true,
      adapter: this.id,
      binary: this.binary,
      version: (result.stdout || result.stderr || '').trim() || null,
    }
  }

  async prepare() {
    // Command runtimes are invoked per request.
  }

  async *run(input = {}) {
    const sandboxSession = this.requireSandboxSession(input)
    const prompt = this.requirePrompt(input)
    const credentialEnv = input.credentials?.env || input.credentialEnv || {}
    const extraEnv = input.env || {}
    const credentialValues = collectCredentialValues(credentialEnv)
    const command = {
      command: this.binary,
      args: this.buildRunArgs(input, prompt),
      cwd: input.cwd || sandboxSession.workspacePath || '.',
      env: envForProcess(this.baseEnv, credentialEnv, extraEnv),
      timeoutMs: input.timeoutMs ?? this.timeoutMs,
      maxEventBytes: input.maxEventBytes ?? this.maxEventBytes,
    }

    yield {
      type: AgentRuntimeEventTypes.COMMAND,
      adapter: this.id,
      command: this.binary,
      args: command.args.map(arg => redactRuntimeValue(arg, credentialValues)),
      cwd: command.cwd,
    }

    let lastExitCode = null
    let finalSummary = ''
    let failureOutput = ''

    try {
      if (input.sessionId) {
        this.running.set(input.sessionId, {
          abort: () => sandboxSession.stop?.(),
        })
      }
      for await (const rawEvent of sandboxSession.run(command)) {
        const event = this.normalizeRuntimeEvent(rawEvent, credentialValues)
        if (event.type === AgentRuntimeEventTypes.TEXT && event.content) {
          finalSummary += event.content
        }
        if (event.type === AgentRuntimeEventTypes.LOG && event.content) {
          failureOutput += event.content
        }
        if (event.type === AgentRuntimeEventTypes.DONE) {
          lastExitCode = event.exitCode
        }
        yield event
      }
    } catch (err) {
      throw this.classifyFailure(
        {
          stderr: err.stderr || err.message,
          stdout: err.stdout || '',
          exitCode: err.exitCode ?? err.code ?? null,
          errorCode: err.code,
        },
        credentialValues,
        err
      )
    } finally {
      if (input.sessionId) this.running.delete(input.sessionId)
    }

    if (lastExitCode && lastExitCode !== 0) {
      throw this.classifyFailure(
        { stderr: failureOutput, stdout: finalSummary, exitCode: lastExitCode },
        credentialValues
      )
    }

    yield {
      type: AgentRuntimeEventTypes.RESULT,
      summary: finalSummary.trim(),
      exitCode: lastExitCode,
    }
  }

  buildRunArgs(input, prompt) {
    return [...(input.runArgs || this.runArgs), prompt]
  }

  async stop(sessionId) {
    const controller = this.running.get(sessionId)
    if (controller) {
      controller.abort()
      this.running.delete(sessionId)
    }
  }

  normalizeRuntimeEvent(rawEvent, credentialValues = []) {
    const event = this.normalizeEvent(rawEvent)
    return redactObject(event, credentialValues)
  }

  classifyFailure(result, credentialValues = [], cause) {
    const rawMessage = [result.stderr, result.stdout, cause?.message]
      .filter(Boolean)
      .join('\n')
      .trim()
    const message = redactRuntimeValue(rawMessage, credentialValues)

    if (result.errorCode === 'ENOENT') {
      return new RuntimeMissingBinaryError(this.missingBinaryMessage, { cause })
    }

    if (this.looksLikeAuthFailure(message)) {
      return new RuntimeAuthError(
        `${this.authFailureLabel} authentication failed: ${message || 'missing or invalid credentials'}`,
        { cause }
      )
    }

    return new RuntimeExecutionError(
      `${this.displayName} execution failed${result.exitCode == null ? '' : ` with exit code ${result.exitCode}`}${message ? `: ${message}` : ''}`,
      { cause, details: { exitCode: result.exitCode ?? null } }
    )
  }

  looksLikeAuthFailure(message) {
    return /(?:auth|credential|api key|apikey|unauthorized|forbidden|401|403|login required|not logged in)/i.test(
      message || ''
    )
  }

  async runCommand({ args, cwd, env, timeoutMs, credentialValues }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let child
    try {
      child = this.runner(this.binary, {
        args,
        cwd,
        env,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      return { exitCode: null, stdout: '', stderr: '', errorCode: err.code }
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })

    let exitCode = null
    let errorCode = null
    let processError = null
    const errorPromise = once(child, 'error').then(([err]) => {
      processError = err
      errorCode = err.code || 'ERROR'
      return null
    })
    const closePromise = once(child, 'close').then(([code]) => code)

    try {
      exitCode = await Promise.race([closePromise, errorPromise])
      if (processError) {
        child.stdout?.destroy?.()
        child.stderr?.destroy?.()
      } else {
        errorPromise.catch(() => {})
      }
    } finally {
      clearTimeout(timer)
    }

    return {
      exitCode,
      errorCode,
      stdout: redactRuntimeValue(stdout, credentialValues),
      stderr: redactRuntimeValue(stderr, credentialValues),
    }
  }

  async *runLocally(input = {}) {
    const prompt = this.requirePrompt(input)
    const credentialEnv = input.credentials?.env || input.credentialEnv || {}
    const extraEnv = input.env || {}
    const credentialValues = collectCredentialValues(credentialEnv)
    const command = {
      command: this.binary,
      args: this.buildRunArgs(input, prompt),
      cwd: input.cwd || process.cwd(),
      env: envForProcess(this.baseEnv, credentialEnv, extraEnv),
      timeoutMs: input.timeoutMs ?? this.timeoutMs,
      maxEventBytes: input.maxEventBytes ?? this.maxEventBytes,
    }

    const localSession = {
      workspacePath: command.cwd,
      run: () => this.streamLocalCommand(command, credentialValues),
    }

    yield* this.run({
      ...input,
      sandboxSession: localSession,
      cwd: command.cwd,
      credentialEnv,
      env: extraEnv,
      runArgs: input.runArgs,
    })
  }

  async *streamLocalCommand(command, credentialValues) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), command.timeoutMs)
    const child = this.runner(command.command, {
      args: command.args,
      cwd: command.cwd,
      env: command.env,
      signal: controller.signal,
    })

    if (!isAsyncIterable(child.stdout) || !isAsyncIterable(child.stderr)) {
      throw new RuntimeInvalidInputError('runner must provide async iterable stdout and stderr streams')
    }

    let exitCode = null
    let processClosed = false
    const queue = []
    let notify
    let doneStreams = 0
    const push = event => {
      queue.push(event)
      notify?.()
      notify = null
    }
    const readStream = async (stream, streamName) => {
      for await (const chunk of stream) {
        push({
          type: streamName,
          content: redactRuntimeValue(String(chunk), credentialValues).slice(0, command.maxEventBytes),
        })
      }
      doneStreams += 1
      notify?.()
      notify = null
    }

    readStream(child.stdout, 'stdout').catch(err => push({ type: 'stderr', content: err.message }))
    readStream(child.stderr, 'stderr').catch(err => push({ type: 'stderr', content: err.message }))
    child.on('close', code => {
      exitCode = code
      processClosed = true
      notify?.()
      notify = null
    })
    child.on('error', err => {
      push({ type: 'stderr', content: err.message })
      processClosed = true
      notify?.()
      notify = null
    })

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift()
        if (doneStreams >= 2 && processClosed) break
        await new Promise(resolve => {
          notify = resolve
        })
      }
      yield { type: 'exit', exitCode }
    } finally {
      clearTimeout(timer)
    }
  }
}

export default CommandRuntimeAdapter
