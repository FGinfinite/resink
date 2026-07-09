#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenCodeRuntimeAdapter } from '../../app/js/runtime/OpenCodeRuntimeAdapter.js'
import { RuntimeErrorCodes } from '../../app/js/runtime/RuntimeErrors.js'

async function* localSandboxRun(adapter, workspacePath, command) {
  yield* adapter.streamLocalCommand(
    {
      command: command.command,
      args: command.args,
      cwd: command.cwd || workspacePath,
      env: command.env,
      timeoutMs: command.timeoutMs,
      maxEventBytes: command.maxEventBytes,
    },
    []
  )
}

function resolveCredentialEnv() {
  const env = {}
  for (const name of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENCODE_API_KEY',
  ]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

const adapter = new OpenCodeRuntimeAdapter()
const credentialEnv = resolveCredentialEnv()
const detection = await adapter.detect({ credentials: { env: credentialEnv } })

if (!detection.ok) {
  const skipReasons = new Set([
    RuntimeErrorCodes.MISSING_BINARY,
    RuntimeErrorCodes.AUTH_FAILURE,
  ])
  if (skipReasons.has(detection.reason)) {
    console.log(`SKIP opencode runtime smoke test: ${detection.message}`)
    process.exit(0)
  }
  console.error(`FAIL opencode runtime smoke test: ${detection.message}`)
  process.exit(1)
}

const workspacePath = await mkdtemp(join(tmpdir(), 'opencode-runtime-'))
try {
  await writeFile(join(workspacePath, 'main.tex'), '\\section{Hello}\\n', 'utf8')

  const sandboxSession = {
    workspacePath,
    run: command => localSandboxRun(adapter, workspacePath, command),
  }

  console.log(`OpenCode detected: ${detection.version || detection.binary}`)
  console.log(`Workspace: ${workspacePath}`)

  const events = []
  for await (const event of adapter.run({
    prompt: 'Read the workspace and respond with exactly: runtime smoke ok',
    sandboxSession,
    credentials: { env: credentialEnv },
    timeoutMs: 60000,
  })) {
    events.push(event)
    if (event.type === 'text') process.stdout.write(event.content)
    if (event.type === 'log') process.stderr.write(event.content)
  }

  const result = events.find(event => event.type === 'result')
  if (!result) {
    console.error('FAIL opencode runtime smoke test: no normalized result event')
    process.exit(1)
  }
  console.log('\nPASS opencode runtime smoke test')
} finally {
  await rm(workspacePath, { recursive: true, force: true })
}
