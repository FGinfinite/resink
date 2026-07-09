#!/usr/bin/env node

import { spawn } from 'node:child_process'
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
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        outputLimited,
      })
    })
  })
}

async function collect(asyncIterable) {
  const events = []
  for await (const event of asyncIterable) {
    events.push(event)
  }
  return events
}

async function dockerAvailable() {
  const result = await runCommand('docker', ['info'], {
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
  })
  return result.exitCode === 0
}

async function main() {
  if (!(await dockerAvailable())) {
    console.log('SKIP: Docker is not available; sandbox smoke test not run.')
    process.exit(0)
  }

  const provider = new LocalDockerSandboxProvider({
    image: process.env.SANDBOX_SMOKE_IMAGE || 'alpine:3.20',
    rootDir: process.env.AI_SANDBOX_ROOT_DIR,
    timeoutMs: 10000,
    maxOutputBytes: 128 * 1024,
    commandRunner: { run: runCommand },
  })

  let session = null
  try {
    session = await provider.createSession()
    console.log(`sandbox id: ${session.id}`)

    const pwdEvents = await collect(session.run({
      command: ['pwd'],
    }))
    const pwd = pwdEvents
      .filter(event => event.type === 'stdout')
      .map(event => event.data)
      .join('')
      .trim()
    if (pwd !== '/workspace') {
      throw new Error(`Expected pwd to be /workspace, got ${pwd}`)
    }
    console.log(`pwd: ${pwd}`)

    await session.writeFile('notes/hello.txt', 'hello sandbox\n')
    const content = await session.readFile('notes/hello.txt')
    if (content.toString('utf-8') !== 'hello sandbox\n') {
      throw new Error('read/write roundtrip failed')
    }
    console.log('file roundtrip: ok')

    const files = await session.listFiles('.')
    console.log(`files: ${files.map(file => file.path).join(', ')}`)

    await session.writeFile('build/output.log', 'artifact log\n')
    const artifacts = await session.collectArtifacts(['build/*.log'])
    if (artifacts.length !== 1 || artifacts[0].path !== 'build/output.log') {
      throw new Error('artifact collection failed')
    }
    console.log(
      `artifacts: ${artifacts.map(artifact => artifact.path).join(', ')}`
    )
  } finally {
    if (session) {
      await provider.destroySession(session.id)
      console.log('destroy: ok')
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
