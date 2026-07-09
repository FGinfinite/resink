#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { LocalDockerSandboxProvider } from '../../app/js/sandbox/LocalDockerSandboxProvider.js'
import { SkillPackageRegistry } from '../../app/js/skill/SkillRegistry.js'
import { RunSkillScriptTool } from '../../app/js/tool/run_skill_script.js'

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
    maxOutputBytes: 1024 * 1024,
    commandRunner: { run: runCommand },
  })
  const registry = await new SkillPackageRegistry().loadAll()
  const tool = new RunSkillScriptTool({ skillRegistry: registry })

  let session = null
  try {
    session = await provider.createSession()
    await session.writeFile(
      'main.tex',
      [
        '\\section{Intro}',
        'This method is evaluated by users and it is improved by feedback.',
        '',
      ].join('\n')
    )

    const result = await tool.execute(
      {
        skill: 'polish',
        script: 'latex_sanity_report.py',
        args: ['main.tex'],
        timeout_ms: 30000,
      },
      {
        sessionId: 'skill-script-smoke',
        toolCallId: 'run-skill-script-smoke',
        persistentWorkspace: { sandboxSession: session },
      }
    )

    if (!result.success) {
      throw new Error(`run_skill_script failed:\n${result.output}`)
    }
    if (!result.data?.stdout?.includes('word_count:')) {
      throw new Error(`Missing word_count in script stdout:\n${result.data?.stdout || ''}`)
    }
    if (!result.data?.events?.some(event => event.type === 'skill.script.completed')) {
      throw new Error('Missing skill.script.completed event')
    }

    console.log(`sandbox id: ${session.id}`)
    console.log('run_skill_script: ok')
    console.log(result.data.stdout.trim())
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
