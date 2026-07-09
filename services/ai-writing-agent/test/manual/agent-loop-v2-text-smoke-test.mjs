#!/usr/bin/env node

/* eslint-disable no-console */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import dotenv from 'dotenv'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '../../.env.sandbox.local') })

function readConfig() {
  const apiBase =
    process.env.SANDBOX_DEBUG_API_BASE ||
    process.env.OPENAI_API_BASE ||
    'https://api.deepseek.com/v1'
  const apiKey =
    process.env.SANDBOX_DEBUG_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  const model =
    process.env.SANDBOX_DEBUG_MODEL_FLASH ||
    process.env.OPENAI_MODEL ||
    'deepseek-v4-flash'

  return { apiBase, apiKey, model }
}

function createContextManager() {
  return {
    buildMessages: async (_sessionId, userMessage) => [
      {
        role: 'system',
        content:
          'You are a concise writing assistant. Reply with one short sentence.',
      },
      { role: 'user', content: userMessage },
    ],
    buildMessagesForResume: async () => [],
    needsCompaction: () => false,
    getConversationHistory: async () => [],
  }
}

async function main() {
  const { AgentLoop } = await import('../../app/js/agent/AgentLoop.js')
  const { LLMAdapter } = await import('../../app/js/adapter/LLMAdapter.js')
  const { ToolRegistry } = await import('../../app/js/tool/ToolRegistry.js')
  const { apiBase, apiKey, model } = readConfig()
  if (!apiKey) {
    console.log(
      'SKIP: missing SANDBOX_DEBUG_API_KEY or OPENAI_API_KEY for live AgentLoopV2 text smoke.'
    )
    return
  }

  const llmAdapter = new LLMAdapter({
    apiBase,
    apiKey,
    model,
    timeout: 30_000,
    retryAttempts: 1,
    maxRetryTimeMs: 45_000,
    maxCompletionTokens: 128,
    temperature: 0,
  })
  const loop = new AgentLoop({
    sessionId: '0123456789abcdef01234567',
    projectId: 'abcdef0123456789abcdef01',
    llmAdapter,
    toolRegistry: new ToolRegistry(),
    contextManager: createContextManager(),
    adapters: {},
    userId: 'fedcba9876543210fedcba98',
    maxTurns: 3,
    maxToolCalls: 0,
  })

  let text = ''
  let done = null
  for await (const event of loop.run(
    'Reply with exactly: AgentLoopV2 text smoke ok.'
  )) {
    if (event.type === 'text') text += event.content || ''
    if (event.type === 'done') done = event
    if (event.type === 'error') {
      throw new Error(event.message || 'AgentLoopV2 text smoke returned error')
    }
  }

  if (!done) {
    throw new Error('AgentLoopV2 text smoke did not emit done event')
  }
  if (!text.trim()) {
    throw new Error('AgentLoopV2 text smoke returned empty text')
  }

  console.log(`endpoint: ${apiBase}`)
  console.log(`model: ${model}`)
  console.log(`text: ${text.trim().slice(0, 200)}`)
  console.log(`finishReason: ${done.finishReason || 'unknown'}`)
}

main()
  .finally(async () => {
    const { mongoClient } = await import('../../app/js/mongodb.js')
    await mongoClient.close().catch(() => {})
  })
  .catch(error => {
    console.error(error.stack || error.message)
    process.exit(1)
  })
