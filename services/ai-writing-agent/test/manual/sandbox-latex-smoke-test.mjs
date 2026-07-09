#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  LocalDockerSandboxProvider,
} from '../../app/js/sandbox/LocalDockerSandboxProvider.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const serviceRoot = path.resolve(__dirname, '../..')
const fixtureRoot = path.join(serviceRoot, 'test/fixtures/sandbox-latex')
const image = process.env.SANDBOX_LATEX_IMAGE || 'resink-ai-sandbox:dev'

function runCommand(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let timedOut = false
    let timer = null

    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs)
      timer.unref?.()
    }

    child.stdout.on('data', chunk => {
      stdout = Buffer.concat([stdout, chunk])
    })
    child.stderr.on('data', chunk => {
      stderr = Buffer.concat([stderr, chunk])
    })
    child.on('error', error => {
      resolve({
        exitCode: 127,
        stdout,
        stderr: Buffer.from(error.message),
        timedOut,
      })
    })
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ exitCode, signal, stdout, stderr, timedOut })
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

async function dockerImageExists() {
  const result = await runCommand('docker', ['image', 'inspect', image], {
    timeoutMs: 10000,
  })
  return result.exitCode === 0
}

function output(events, type) {
  return events
    .filter(event => event.type === type)
    .map(event => event.data)
    .join('')
}

async function main() {
  if (!(await dockerImageExists())) {
    console.log(
      `SKIP: Docker image ${image} is missing. Build with: docker build -f sandbox/Dockerfile -t ${image} .`
    )
    process.exit(0)
  }

  const provider = new LocalDockerSandboxProvider({
    image,
    rootDir: process.env.AI_SANDBOX_ROOT_DIR,
    timeoutMs: 120000,
    maxOutputBytes: 2 * 1024 * 1024,
    maxArtifactBytes: 10 * 1024 * 1024,
    commandRunner: { run: runCommand },
  })

  let session = null
  try {
    session = await provider.createSession()
    const tex = await fs.readFile(path.join(fixtureRoot, 'main.tex'), 'utf8')
    await session.writeFile('main.tex', tex)

    const compileEvents = await collect(session.run({
      command: ['latexmk', '-pdf', '-interaction=nonstopmode', 'main.tex'],
      timeoutMs: 120000,
      maxOutputBytes: 2 * 1024 * 1024,
    }))
    const compileExit = compileEvents.find(event => event.type === 'exit')
    if (compileExit?.exitCode !== 0) {
      throw new Error(
        `latexmk failed:\n${output(compileEvents, 'stdout')}\n${output(compileEvents, 'stderr')}`
      )
    }

    const textEvents = await collect(session.run({
      command: ['pdftotext', 'main.pdf', '-'],
      timeoutMs: 30000,
      maxOutputBytes: 256 * 1024,
    }))
    const extractedText = output(textEvents, 'stdout')
    if (!extractedText.includes('compiled inside the sandbox runtime')) {
      throw new Error(`pdftotext output did not contain expected text: ${extractedText}`)
    }

    const artifacts = await session.collectArtifacts(['main.pdf', 'main.log'])
    console.log(`sandbox id: ${session.id}`)
    console.log('latexmk: ok')
    console.log('pdftotext: ok')
    console.log(`artifacts: ${artifacts.map(artifact => artifact.path).join(', ')}`)
  } finally {
    if (session) {
      await provider.destroySession(session.id)
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
