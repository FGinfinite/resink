import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AgentRuntimeEventTypes } from '../../../../app/js/runtime/AgentRuntimeAdapter.js'
import { CodexRuntimeAdapter } from '../../../../app/js/runtime/CodexRuntimeAdapter.js'
import { RuntimeErrorCodes } from '../../../../app/js/runtime/RuntimeErrors.js'

function streamFrom(items = []) {
  return Readable.from(items)
}

function createProcess({
  stdout = [],
  stderr = [],
  closeCode = 0,
  error = null,
} = {}) {
  const child = new EventEmitter()
  child.stdout = streamFrom(stdout)
  child.stderr = streamFrom(stderr)
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}

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

describe('CodexRuntimeAdapter', () => {
  it('detects missing codex binary', async () => {
    const adapter = new CodexRuntimeAdapter({
      runner: () => {
        const err = new Error('missing')
        err.code = 'ENOENT'
        throw err
      },
    })

    const result = await adapter.detect()

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(RuntimeErrorCodes.MISSING_BINARY)
    expect(result.message).toContain('Codex CLI binary not found')
  })

  it('builds non-interactive codex exec args for a sandbox workspace', async () => {
    const adapter = new CodexRuntimeAdapter({
      baseEnv: {},
      binary: 'codex-test',
      model: 'gpt-test',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
    })
    const workspacePath = '/tmp/codex-workspace'

    const events = await collect(
      adapter.run({
        prompt: 'inspect project',
        sandboxSession: {
          workspacePath,
          run: async function* (command) {
            expect(command.command).toBe('codex-test')
            expect(command.args).toEqual([
              'exec',
              '--skip-git-repo-check',
              '-m',
              'gpt-test',
              '-c',
              'model_reasoning_effort="high"',
              '--sandbox',
              'workspace-write',
              '--full-auto',
              '-C',
              workspacePath,
              'inspect project',
            ])
            yield { type: 'stdout', content: 'codex ok' }
            yield { type: 'exit', exitCode: 0 }
          },
        },
      })
    )

    expect(events[0]).toMatchObject({
      type: AgentRuntimeEventTypes.COMMAND,
      adapter: 'codex',
      command: 'codex-test',
    })
    expect(events.at(-1)).toMatchObject({
      type: AgentRuntimeEventTypes.RESULT,
      summary: 'codex ok',
    })
  })

  it('redacts credentials from command output', async () => {
    const adapter = new CodexRuntimeAdapter({ baseEnv: {} })

    const events = await collect(
      adapter.run({
        prompt: 'run',
        credentials: { env: { OPENAI_API_KEY: 'sk-codex-secret' } },
        sandboxSession: {
          workspacePath: '/tmp/workspace',
          run: async function* () {
            yield {
              type: 'stderr',
              content: 'debug OPENAI_API_KEY=sk-codex-secret',
            }
            yield { type: 'exit', exitCode: 0 }
          },
        },
      })
    )

    const log = events.find(event => event.type === AgentRuntimeEventTypes.LOG)
    expect(log.content).toContain('[redacted]')
    expect(log.content).not.toContain('sk-codex-secret')
  })

  it('supports local detection through --version', async () => {
    const adapter = new CodexRuntimeAdapter({
      runner: () => createProcess({ stdout: ['codex 1.2.3'], closeCode: 0 }),
    })

    const result = await adapter.detect()

    expect(result).toMatchObject({
      ok: true,
      adapter: 'codex',
      binary: 'codex',
      version: 'codex 1.2.3',
    })
  })
})
