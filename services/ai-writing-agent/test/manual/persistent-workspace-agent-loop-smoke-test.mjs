#!/usr/bin/env node

/* eslint-disable no-console */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentLoop } from '../../app/js/agent/AgentLoop.js'
import { ToolRegistry } from '../../app/js/tool/ToolRegistry.js'
import { ListFilesTool } from '../../app/js/tool/list.js'
import { ReadDocumentTool } from '../../app/js/tool/read.js'
import { EditDocumentTool } from '../../app/js/tool/edit.js'
import { mongoClient } from '../../app/js/mongodb.js'
import {
  LocalDockerSandboxProvider,
} from '../../app/js/sandbox/LocalDockerSandboxProvider.js'

function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let outputLimited = false
    let timer = null
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024

    function append(chunk, previous) {
      const next = Buffer.concat([previous, chunk])
      if (next.length > maxOutputBytes) {
        outputLimited = true
        child.kill('SIGKILL')
      }
      return next
    }

    child.stdout.on('data', chunk => {
      stdout = append(chunk, stdout)
    })
    child.stderr.on('data', chunk => {
      stderr = append(chunk, stderr)
    })
    child.on('error', error => {
      resolve({
        exitCode: 127,
        signal: null,
        stdout,
        stderr: Buffer.from(error.message),
        timedOut,
        outputLimited,
      })
    })

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs)
      timer.unref?.()
    }

    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode, signal, stdout, stderr, timedOut, outputLimited })
    })
  })
}

async function dockerAvailable() {
  const result = await runCommand('docker', ['info'], {
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
  })
  return result.exitCode === 0
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

class ScriptedLLM {
  constructor(responses) {
    this.responses = responses
    this.index = 0
  }

  async chat(options = {}) {
    const response = this.responses[this.index++] || {
      content: 'done',
      toolCalls: null,
      finishReason: 'stop',
    }
    if (options.stream) {
      return this.streamResponse(response)
    }
    return {
      content: response.content || '',
      toolCalls: response.toolCalls || null,
      finishReason: response.finishReason || (response.toolCalls ? 'tool_calls' : 'stop'),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }

  async *streamResponse(response) {
    if (response.content) {
      yield { type: 'text', content: response.content }
    }
    for (const toolCall of response.toolCalls || []) {
      yield { type: 'tool_call', toolCall }
    }
    yield {
      type: 'done',
      content: response.content || '',
      toolCalls: response.toolCalls || [],
      finishReason: response.finishReason || (response.toolCalls ? 'tool_calls' : 'stop'),
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }
  }
}

function createToolRegistry() {
  const registry = new ToolRegistry()
  registry.register(new ListFilesTool())
  registry.register(new ReadDocumentTool())
  registry.register(new EditDocumentTool())
  return registry
}

function createContextManager() {
  return {
    buildMessages: async (_sessionId, userMessage) => [
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: userMessage },
    ],
    buildMessagesForResume: async () => [],
    needsCompaction: () => false,
    getConversationHistory: async () => [],
  }
}

async function collect(asyncIterable) {
  const events = []
  for await (const event of asyncIterable) {
    events.push(event)
  }
  return events
}

async function main() {
  if (!(await dockerAvailable())) {
    console.log('SKIP: Docker is not available; agent-loop workspace smoke not run.')
    process.exit(0)
  }

  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'overleaf-ai-loop-'))
  const provider = new LocalDockerSandboxProvider({
    image: process.env.SANDBOX_SMOKE_IMAGE || 'alpine:3.20',
    rootDir,
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
    commandRunner: { run: runCommand },
  })
  const sandboxSession = await provider.createSession({ id: 'loop-smoke' })

  try {
    await sandboxSession.writeFile('main.tex', 'Before line\n')
    const persistentWorkspace = {
      workspaceId: 'loop-smoke',
      sandboxSession,
    }
    const baseLoopOptions = {
      sessionId: '0123456789abcdef01234567',
      projectId: 'abcdef0123456789abcdef01',
      toolRegistry: createToolRegistry(),
      contextManager: createContextManager(),
      adapters: {},
      currentDocPath: '/main.tex',
      userId: 'fedcba9876543210fedcba98',
      maxTurns: 5,
      maxToolCalls: 10,
    }

    const firstLoop = new AgentLoop({
      ...baseLoopOptions,
      llmAdapter: new ScriptedLLM([
        {
          toolCalls: [
            toolCall('read-1', 'read_document', { path: 'main.tex' }),
          ],
        },
        {
          toolCalls: [
            toolCall('edit-1', 'edit_document', {
              path: 'main.tex',
              oldText: 'Before',
              newText: 'After',
            }),
          ],
        },
        { content: 'first turn done', finishReason: 'stop' },
      ]),
    })
    await collect(firstLoop.run('Edit main.tex', {
      _persistentWorkspace: persistentWorkspace,
    }))

    const afterFirst = (await sandboxSession.readFile('main.tex')).toString('utf8')
    if (!afterFirst.includes('After line')) {
      throw new Error(`first turn did not edit workspace: ${afterFirst}`)
    }
    console.log('first-turn edit: ok')

    const secondLoop = new AgentLoop({
      ...baseLoopOptions,
      llmAdapter: new ScriptedLLM([
        {
          toolCalls: [
            toolCall('read-2', 'read_document', { path: 'main.tex' }),
          ],
        },
        { content: 'second turn saw persisted edit', finishReason: 'stop' },
      ]),
    })
    const secondEvents = await collect(secondLoop.run('Read main.tex again', {
      _persistentWorkspace: persistentWorkspace,
    }))
    const readEvent = secondEvents.find(event =>
      event.type === 'tool_result' && event.toolName === 'read_document'
    )
    if (!readEvent?.result?.output?.includes('After line')) {
      throw new Error('second turn did not read persisted workspace edit')
    }
    console.log('second-turn read: ok')
  } finally {
    await provider.destroySession(sandboxSession.id).catch(() => {})
    await mongoClient.close().catch(() => {})
    await rm(rootDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
