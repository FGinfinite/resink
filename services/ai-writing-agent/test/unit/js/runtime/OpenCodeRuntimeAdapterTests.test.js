import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { AgentRuntimeEventTypes } from '../../../../app/js/runtime/AgentRuntimeAdapter.js'
import { OpenCodeRuntimeAdapter, redactRuntimeValue } from '../../../../app/js/runtime/OpenCodeRuntimeAdapter.js'
import { RuntimeErrorCodes } from '../../../../app/js/runtime/RuntimeErrors.js'

function streamFrom(items = []) {
  return Readable.from(items)
}

function createProcess({ stdout = [], stderr = [], closeCode = 0, error = null } = {}) {
  const child = new EventEmitter()
  child.stdout = streamFrom(stdout)
  child.stderr = streamFrom(stderr)
  child.stdout.setEncoding = vi.fn()
  child.stderr.setEncoding = vi.fn()

  setTimeout(() => {
    if (error) child.emit('error', error)
    child.emit('close', closeCode)
  })

  return child
}

async function collect(iterable) {
  const events = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

async function* throwFromRuntime(error) {
  for await (const event of []) {
    yield event
  }
  throw error
}

async function expectRejectsMatching(promise, expected) {
  try {
    await promise
    expect.unreachable('Expected rejection')
  } catch (error) {
    expect(error).toMatchObject(expected)
  }
}

describe('OpenCodeRuntimeAdapter', () => {
  it('detects missing binary', async () => {
    const adapter = new OpenCodeRuntimeAdapter({
      runner: () => {
        const err = new Error('missing')
        err.code = 'ENOENT'
        throw err
      },
    })

    const result = await adapter.detect()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(RuntimeErrorCodes.MISSING_BINARY)
    expect(result.message).toContain('OpenCode binary not found')
  })

  it('detects auth failures without leaking credentials', async () => {
    const adapter = new OpenCodeRuntimeAdapter({
      runner: () =>
        createProcess({
          stderr: ['401 unauthorized OPENAI_API_KEY=sk-secret-value'],
          closeCode: 1,
        }),
    })

    const result = await adapter.detect({
      credentials: { env: { OPENAI_API_KEY: 'sk-secret-value' } },
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(RuntimeErrorCodes.AUTH_FAILURE)
    expect(result.message).toContain('[redacted]')
    expect(result.message).not.toContain('sk-secret-value')
  })

  it('detects execution failures distinctly from auth failures', async () => {
    const adapter = new OpenCodeRuntimeAdapter({
      runner: () => createProcess({ stderr: ['unexpected cli error'], closeCode: 2 }),
    })

    const result = await adapter.detect()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(RuntimeErrorCodes.EXECUTION_FAILURE)
  })

  it('runs a non-interactive prompt through sandbox session and normalizes events', async () => {
    const run = vi.fn(async function* (command) {
      expect(command.command).toBe('opencode')
      expect(command.args).toEqual([
        'run',
        '--model',
        'openai/deepseek-v4-flash',
        '--dir',
        '/workspace',
        'say hello',
      ])
      expect(command.env.OPENAI_API_KEY).toBe('sk-runtime-secret')
      yield { type: 'stdout', content: 'hello ' }
      yield { type: 'stderr', content: 'debug OPENAI_API_KEY=sk-runtime-secret' }
      yield { type: 'exit', exitCode: 0 }
    })
    const adapter = new OpenCodeRuntimeAdapter({
      baseEnv: {},
      model: 'openai/deepseek-v4-flash',
    })

    const events = await collect(
      adapter.run({
        prompt: 'say hello',
        sandboxSession: { workspacePath: '/tmp/workspace', run },
        credentials: { env: { OPENAI_API_KEY: 'sk-runtime-secret' } },
      })
    )

    expect(events[0]).toMatchObject({
      type: AgentRuntimeEventTypes.COMMAND,
      command: 'opencode',
    })
    expect(events.some(event => event.type === AgentRuntimeEventTypes.TEXT && event.content === 'hello ')).toBe(true)
    const log = events.find(event => event.type === AgentRuntimeEventTypes.LOG)
    expect(log.content).toContain('[redacted]')
    expect(log.content).not.toContain('sk-runtime-secret')
    expect(events.at(-1)).toMatchObject({
      type: AgentRuntimeEventTypes.RESULT,
      summary: 'hello',
      exitCode: 0,
    })
  })

  it('uses OpenAI-compatible env vars to configure OpenCode provider and model', async () => {
    const run = vi.fn(async function* (command) {
      expect(command.args).toEqual([
        'run',
        '--model',
        'overleaf/deepseek-v4-pro',
        '--dir',
        '/workspace',
        'say hello',
      ])
      const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT)
      expect(config.model).toBe('overleaf/deepseek-v4-pro')
      expect(config.provider.overleaf.options.baseURL).toBe('https://example.test/v1')
      expect(config.provider.overleaf.options.apiKey).toBe('{env:OPENAI_API_KEY}')
      expect(command.env.OPENCODE_CONFIG_CONTENT).not.toContain('sk-runtime-secret')
      yield { type: 'stdout', content: 'hello' }
      yield { type: 'exit', exitCode: 0 }
    })
    const adapter = new OpenCodeRuntimeAdapter({
      baseEnv: {
        OPENAI_API_BASE: 'https://example.test/v1',
        OPENAI_MODEL: 'deepseek-v4-pro',
      },
    })

    const events = await collect(
      adapter.run({
        prompt: 'say hello',
        sandboxSession: { workspacePath: '/tmp/workspace', run },
        credentials: { env: { OPENAI_API_KEY: 'sk-runtime-secret' } },
      })
    )

    expect(events.at(-1)).toMatchObject({
      type: AgentRuntimeEventTypes.RESULT,
      summary: 'hello',
      exitCode: 0,
    })
  })

  it('throws redacted auth errors from sandbox execution', async () => {
    const adapter = new OpenCodeRuntimeAdapter({ baseEnv: {} })

    await expectRejectsMatching(
      collect(
        adapter.run({
          prompt: 'run',
          sandboxSession: {
            workspacePath: '/tmp/workspace',
            run: () => {
              const err = new Error('403 forbidden Bearer sk-runtime-secret')
              err.exitCode = 1
              return throwFromRuntime(err)
            },
          },
          credentials: { env: { OPENAI_API_KEY: 'sk-runtime-secret' } },
        })
      ),
      { code: RuntimeErrorCodes.AUTH_FAILURE }
    )
  })

  it('redacts common credential shapes', () => {
    const text = redactRuntimeValue(
      'Authorization: Bearer sk-secret-value\nOPENAI_API_KEY=sk-secret-value\nplain sk-secret-value',
      ['sk-secret-value']
    )

    expect(text).not.toContain('sk-secret-value')
    expect(text).toContain('[redacted]')
  })
})
