#!/usr/bin/env node

/* eslint-disable no-console */

import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PersistentWorkspaceManager } from '../../app/js/sandbox/PersistentWorkspaceManager.js'
import {
  LocalDockerSandboxProvider,
} from '../../app/js/sandbox/LocalDockerSandboxProvider.js'

const SESSION_ID = '0123456789abcdef01234567'
const PROJECT_ID = 'abcdef0123456789abcdef01'
const USER_ID = 'fedcba9876543210fedcba98'

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

function createCollection(seed = []) {
  const docs = seed
  return {
    docs,
    insertOne: async doc => {
      docs.push({ ...doc })
      return { insertedId: doc._id }
    },
    updateOne: async (filter, update) => {
      const doc = docs.find(candidate => matches(candidate, filter))
      if (!doc) return { matchedCount: 0, modifiedCount: 0 }
      Object.assign(doc, update.$set || {})
      for (const key of Object.keys(update.$unset || {})) {
        delete doc[key]
      }
      return { matchedCount: 1, modifiedCount: 1 }
    },
    findOne: async filter => docs.find(doc => matches(doc, filter)) || null,
    find: filter => ({
      toArray: async () => docs.filter(doc => matches(doc, filter)),
    }),
  }
}

function matches(doc, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    const actual = doc[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual)
      if ('$nin' in expected) return !expected.$nin.includes(actual)
      if ('$gt' in expected) return actual > expected.$gt
      if ('$lte' in expected) return actual <= expected.$lte
    }
    if (key === '_id' && actual?.toString) return actual.toString() === expected
    return actual === expected
  })
}

function runtimeConfig(rootDir) {
  return {
    sandboxEnabled: true,
    agentLoopV2Enabled: false,
    sandbox: {
      provider: 'local-docker',
      image: process.env.SANDBOX_SMOKE_IMAGE || 'alpine:3.20',
      rootDir,
      workspaceTtlMs: 60_000,
      commandTimeoutMs: 10_000,
      maxOutputBytes: 128 * 1024,
      maxArtifactBytes: 1024 * 1024,
      maxFileCount: 100,
      networkPolicy: 'none',
      memoryBytes: null,
      memorySwapBytes: null,
      cpuCount: null,
      pidsLimit: null,
    },
  }
}

function createProvider(rootDir) {
  return new LocalDockerSandboxProvider({
    image: process.env.SANDBOX_SMOKE_IMAGE || 'alpine:3.20',
    rootDir,
    timeoutMs: 10_000,
    maxOutputBytes: 128 * 1024,
    commandRunner: { run: runCommand },
  })
}

function createManager({ provider, rootDir, workspacesCollection, sessionsCollection }) {
  return new PersistentWorkspaceManager({
    getRuntimeConfig: () => runtimeConfig(rootDir),
    provider,
    workspacesCollection,
    sessionsCollection,
    exporter: {
      exportProject: async (_projectId, workspacePath) => {
        await writeFile(
          path.join(workspacePath, 'main.tex'),
          '\\documentclass{article}\\begin{document}hello\\end{document}\\n'
        )
        return {
          version: 1,
          files: [
            {
              path: 'main.tex',
              entityType: 'doc',
              entityId: 'doc-main',
              baseVersion: 1,
            },
          ],
        }
      },
    },
    projectAdapter: {
      getEntities: async () => ({
        docs: [{ id: 'doc-main', path: '/main.tex' }],
        files: [],
      }),
    },
    documentAdapter: {
      getDocumentContent: async () => ({
        content: 'current',
        version: 1,
      }),
    },
  })
}

async function main() {
  if (!(await dockerAvailable())) {
    console.log('SKIP: Docker is not available; persistent workspace smoke not run.')
    process.exit(0)
  }

  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'overleaf-ai-pws-'))
  const workspacesCollection = createCollection()
  const sessionsCollection = createCollection([{ _id: SESSION_ID }])

  try {
    const firstProvider = createProvider(rootDir)
    const firstManager = createManager({
      provider: firstProvider,
      rootDir,
      workspacesCollection,
      sessionsCollection,
    })
    const created = await firstManager.ensureWorkspace({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })
    await created.sandboxSession.writeFile('notes/state.txt', 'persisted\n')
    console.log(`created: ${created.created}`)
    console.log(`workspace: ${created.workspace._id}`)

    const restoredProvider = createProvider(rootDir)
    const restoredManager = createManager({
      provider: restoredProvider,
      rootDir,
      workspacesCollection,
      sessionsCollection,
    })
    const restored = await restoredManager.ensureWorkspace({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })
    const content = await restored.sandboxSession.readFile('notes/state.txt')
    if (content.toString('utf-8') !== 'persisted\n') {
      throw new Error('restored workspace did not preserve sandbox state')
    }
    console.log(`restored: ${restored.created === false}`)

    const workspace = workspacesCollection.docs[0]
    workspace.expiresAt = new Date(Date.now() - 1000)
    const workspaceRoot = path.dirname(workspace.workspacePath)
    const cleanupManager = createManager({
      provider: null,
      rootDir,
      workspacesCollection,
      sessionsCollection,
    })
    const cleanup = await cleanupManager.cleanupExpired()
    if (!cleanup.removedWorkspaces.includes(workspace._id)) {
      throw new Error('expired workspace was not marked as removed')
    }
    await access(workspaceRoot)
      .then(() => {
        throw new Error('expired workspace directory still exists')
      })
      .catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
    console.log('cleanup: ok')
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
