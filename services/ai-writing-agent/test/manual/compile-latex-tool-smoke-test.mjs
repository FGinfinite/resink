#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  LocalDockerSandboxProvider,
} from '../../app/js/sandbox/LocalDockerSandboxProvider.js'
import { CompileLatexTool } from '../../app/js/tool/compile_latex.js'

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

async function dockerImageExists() {
  const result = await runCommand('docker', ['image', 'inspect', image], {
    timeoutMs: 10000,
  })
  return result.exitCode === 0
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
  const storedArtifacts = []
  const tool = new CompileLatexTool({
    artifactsCollection: {
      insertMany: async docs => storedArtifacts.push(...docs),
    },
  })

  let session = null
  try {
    session = await provider.createSession()
    const tex = await fs.readFile(path.join(fixtureRoot, 'main.tex'), 'utf8')
    await session.writeFile('main.tex', tex)

    const result = await tool.execute(
      { entry_file: 'main.tex', engine: 'pdf', timeout_ms: 120000 },
      {
        sessionId: '0123456789abcdef01234567',
        persistentWorkspace: { sandboxSession: session },
      }
    )

    if (!result.success || !result.data?.compiled) {
      throw new Error(`compile_latex failed:\n${result.output}`)
    }
    const paths = storedArtifacts.map(artifact => artifact.path).sort()
    if (!paths.includes('main.pdf') || !paths.includes('main.log')) {
      throw new Error(`compile_latex did not store pdf/log artifacts: ${paths.join(', ')}`)
    }
    if (!result.output.includes('/api/ai/sessions/0123456789abcdef01234567/artifacts/')) {
      throw new Error(`compile_latex output did not include artifact download URLs:\n${result.output}`)
    }

    console.log(`sandbox id: ${session.id}`)
    console.log('compile_latex: ok')
    console.log(`artifacts: ${paths.join(', ')}`)
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
