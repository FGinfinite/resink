#!/usr/bin/env node

/* eslint-disable no-console */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import dotenv from 'dotenv'
import { AgentLoop } from '../../app/js/agent/AgentLoop.js'
import { LLMAdapter } from '../../app/js/adapter/LLMAdapter.js'
import { ToolRegistry } from '../../app/js/tool/ToolRegistry.js'
import { RunCommandTool } from '../../app/js/tool/run_command.js'
import {
  LocalDockerSandboxProvider,
} from '../../app/js/sandbox/LocalDockerSandboxProvider.js'
import { mongoClient } from '../../app/js/mongodb.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '../../.env.sandbox.local') })

function readConfig() {
  return {
    apiBase:
      process.env.SANDBOX_DEBUG_API_BASE ||
      process.env.OPENAI_API_BASE ||
      'https://api.deepseek.com/v1',
    apiKey:
      process.env.SANDBOX_DEBUG_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '',
    model:
      process.env.SANDBOX_DEBUG_MODEL_FLASH ||
      process.env.OPENAI_MODEL ||
      'deepseek-v4-flash',
  }
}

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

function createContextManager() {
  return {
    buildMessages: async (_sessionId, userMessage) => [
      {
        role: 'system',
        content:
          'You must use the run_command tool exactly once when asked for a command smoke test. After the tool returns, summarize the observed stdout.',
      },
      { role: 'user', content: userMessage },
    ],
    buildMessagesForResume: async () => [],
    needsCompaction: () => false,
    getConversationHistory: async () => [],
  }
}

async function main() {
  const { apiBase, apiKey, model } = readConfig()
  if (!apiKey) {
    console.log(
      'SKIP: missing SANDBOX_DEBUG_API_KEY or OPENAI_API_KEY for live AgentLoopV2 command smoke.'
    )
    return
  }
  if (!(await dockerAvailable())) {
    console.log('SKIP: Docker is not available; live command smoke not run.')
    return
  }

  const rootDir = await mkdtemp(join(os.tmpdir(), 'overleaf-ai-command-smoke-'))
  const provider = new LocalDockerSandboxProvider({
    image: process.env.SANDBOX_SMOKE_IMAGE || 'alpine:3.20',
    rootDir,
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
    networkPolicy: 'deny',
    commandRunner: { run: runCommand },
  })
  const sandboxSession = await provider.createSession({ id: `command-${Date.now()}` })

  try {
    const registry = new ToolRegistry()
    registry.register(new RunCommandTool())
    const loop = new AgentLoop({
      sessionId: '0123456789abcdef01234567',
      projectId: 'abcdef0123456789abcdef01',
      llmAdapter: new LLMAdapter({
        apiBase,
        apiKey,
        model,
        timeout: 30_000,
        retryAttempts: 1,
        maxRetryTimeMs: 45_000,
        maxCompletionTokens: 512,
        temperature: 0,
      }),
      toolRegistry: registry,
      contextManager: createContextManager(),
      adapters: {},
      userId: 'fedcba9876543210fedcba98',
      maxTurns: 4,
      maxToolCalls: 2,
    })

    const events = []
    for await (const event of loop.run(
      'Run the command smoke test by calling run_command with command ["printf", "agent-command-smoke-ok\\n"], workdir ".", timeout_ms 10000, max_output_bytes 4096. Then answer with the stdout.',
      {
        _persistentWorkspace: {
          workspace: { _id: 'command-smoke-workspace' },
          sandboxSession,
        },
        profile: 'default',
        agentName: 'live-command-smoke',
      }
    )) {
      events.push(event)
      if (event.type === 'error') {
        throw new Error(event.message || 'AgentLoopV2 command smoke returned error')
      }
    }

    const commandResult = events.find(event =>
      event.type === 'tool_result' && event.toolName === 'run_command'
    )
    if (!commandResult) {
      throw new Error('run_command tool was not called by the live model')
    }
    if (!commandResult.result?.data?.stdout?.includes('agent-command-smoke-ok')) {
      throw new Error(
        `unexpected command result: ${JSON.stringify(commandResult.result?.data || {})}`
      )
    }
    const diagnostics = commandResult.result.data.events?.map(event => event.type) || []
    if (!diagnostics.includes('command.started') || !diagnostics.includes('command.completed')) {
      throw new Error(`missing command diagnostics: ${diagnostics.join(', ')}`)
    }

    console.log(`endpoint: ${apiBase}`)
    console.log(`model: ${model}`)
    console.log(`tool stdout: ${commandResult.result.data.stdout.trim()}`)
    console.log(`diagnostics: ${diagnostics.join(', ')}`)
  } finally {
    await provider.destroySession(sandboxSession.id).catch(() => {})
    await mongoClient.close().catch(() => {})
    await rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
