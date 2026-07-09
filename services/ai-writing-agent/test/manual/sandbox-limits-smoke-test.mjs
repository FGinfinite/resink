#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

async function expectRejects(label, promise, code) {
  try {
    await promise
    throw new Error(`${label}: expected failure`)
  } catch (error) {
    if (code && error.code !== code) {
      throw new Error(`${label}: expected ${code}, got ${error.code || error.message}`)
    }
    console.log(`${label}: ok`)
  }
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
    console.log('SKIP: Docker is not available; sandbox limits smoke not run.')
    process.exit(0)
  }

  const provider = new LocalDockerSandboxProvider({
    image: process.env.SANDBOX_SMOKE_IMAGE || 'alpine:3.20',
    timeoutMs: 10000,
    maxOutputBytes: 128 * 1024,
    maxFileCount: 2,
    memoryBytes: 64 * 1024 * 1024,
    memorySwapBytes: 64 * 1024 * 1024,
    cpuCount: 0.5,
    pidsLimit: 64,
    networkPolicy: 'deny',
    commandRunner: { run: runCommand },
  })

  let session = null
  try {
    const before = await provider.startupCleanup()
    console.log(`startup cleanup containers: ${before.removedContainers.length}`)

    session = await provider.createSession({ id: `limits-${Date.now()}` })
    console.log(`sandbox id: ${session.id}`)

    const inspect = await provider.runDocker([
      'inspect',
      session.containerName,
      '--format',
      '{{.HostConfig.NetworkMode}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}',
    ])
    const limits = inspect.stdout.toString('utf-8').trim()
    if (!limits.startsWith('none 67108864 500000000 64')) {
      throw new Error(`unexpected Docker limits: ${limits}`)
    }
    console.log(`docker limits: ${limits}`)

    const socketProbe = await collect(session.run({
      command: ['sh', '-c', 'test ! -S /var/run/docker.sock'],
    }))
    const socketExit = socketProbe.find(event => event.type === 'exit')?.exitCode
    if (socketExit !== 0) {
      throw new Error('docker socket is visible inside sandbox')
    }
    console.log('docker socket absent: ok')

    const networkProbe = await collect(session.run({
      command: ['sh', '-c', 'wget -T 2 -qO- http://1.1.1.1 >/tmp/net.out 2>/tmp/net.err'],
      timeoutMs: 4000,
    }))
    const networkExit = networkProbe.find(event => event.type === 'exit')?.exitCode
    if (networkExit === 0) {
      throw new Error('network probe unexpectedly succeeded')
    }
    console.log('network deny probe: ok')

    await session.writeFile('a.txt', 'a')
    await session.writeFile('b.txt', 'b')
    await session.writeFile('c.txt', 'c')
    await collect(session.run({ command: ['true'] }))
    await session.listFiles('.').then(() => {
      throw new Error('expected max file count to fail')
    }).catch(error => {
      if (error.code !== 'SANDBOX_FILE_COUNT_LIMIT') throw error
    })
    console.log('file count limit: ok')

    await expectRejects(
      'timeout limit',
      collect(session.run({ command: ['sleep', '5'], timeoutMs: 100 })),
      'SANDBOX_TIMEOUT'
    )
    await expectRejects(
      'output byte limit',
      collect(session.run({
        command: ['sh', '-c', 'yes x'],
        maxOutputBytes: 1024,
        timeoutMs: 5000,
      })),
      'SANDBOX_OUTPUT_LIMIT'
    )

    const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'sandbox-smoke-outside-'))
    try {
      await writeFile(path.join(outsideDir, 'secret.txt'), 'secret')
      await symlink(outsideDir, path.join(session.workspacePath, 'outside-link'))
      await expectRejects(
        'symlink escape read',
        session.readFile('outside-link/secret.txt'),
        'SANDBOX_PATH_ERROR'
      )
      await expectRejects(
        'symlink escape write',
        session.writeFile('outside-link/new.txt', 'no'),
        'SANDBOX_PATH_ERROR'
      )
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }

    const leakedContainerName = session.containerName
    session = null
    const after = await provider.manualCleanup({ includeActive: true })
    if (!after.removedContainers.includes(leakedContainerName)) {
      throw new Error('manual cleanup did not remove leaked container')
    }
    console.log(`manual cleanup containers: ${after.removedContainers.length}`)
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
