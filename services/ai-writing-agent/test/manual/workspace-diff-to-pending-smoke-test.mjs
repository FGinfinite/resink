#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  LocalDockerSandboxProvider,
} from '../../app/js/sandbox/LocalDockerSandboxProvider.js'
import { PersistentWorkspaceManager } from '../../app/js/sandbox/PersistentWorkspaceManager.js'
import { ProjectDiffCollector, writeBaseSnapshot } from '../../app/js/sandbox/ProjectDiffCollector.js'
import { PatchToPendingChanges } from '../../app/js/sandbox/PatchToPendingChanges.js'

const image = process.env.SANDBOX_LATEX_IMAGE || 'resink-ai-sandbox:dev'
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
      resolve({ exitCode: 127, stdout, stderr: Buffer.from(error.message), timedOut })
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

function createCollection(seed = []) {
  const docs = [...seed]
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
      for (const key of Object.keys(update.$unset || {})) delete doc[key]
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
    if (actual?.toString || expected?.toString) {
      return String(actual) === String(expected)
    }
    return actual === expected
  })
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

async function main() {
  if (!(await dockerImageExists())) {
    console.log(
      `SKIP: Docker image ${image} is missing. Build with: docker build -f sandbox/Dockerfile -t ${image} .`
    )
    process.exit(0)
  }

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-diff-smoke-'))
  const provider = new LocalDockerSandboxProvider({
    image,
    rootDir,
    timeoutMs: 120000,
    maxOutputBytes: 1024 * 1024,
    maxArtifactBytes: 10 * 1024 * 1024,
    commandRunner: { run: runCommand },
  })
  const workspacesCollection = createCollection()
  const sessionsCollection = createCollection([
    { _id: { toString: () => SESSION_ID }, projectId: PROJECT_ID, userId: USER_ID },
  ])
  const baseText = 'Hello from canonical Overleaf.\n'
  const manifest = {
    version: 1,
    projectId: PROJECT_ID,
    files: [
      {
        path: '/main.tex',
        workspacePath: 'main.tex',
        entityType: 'doc',
        entityId: 'doc-1',
        baseVersion: 7,
        sha256: sha256(baseText),
        size: Buffer.byteLength(baseText),
        binary: false,
      },
    ],
  }
  const exporter = {
    exportProject: async (_projectId, workspacePath) => {
      await fs.writeFile(path.join(workspacePath, 'main.tex'), baseText)
      await writeBaseSnapshot(workspacePath, manifest)
      await fs.writeFile(
        path.join(workspacePath, '.overleaf-snapshot-manifest.json'),
        JSON.stringify(manifest, null, 2)
      )
      return manifest
    },
  }
  const projectAdapter = {
    getEntities: async () => ({
      docs: [{ id: 'doc-1', path: '/main.tex', name: 'main.tex' }],
      files: [],
    }),
  }
  const documentAdapter = {
    getDocumentContent: async () => ({
      content: baseText,
      version: 7,
    }),
  }
  const manager = new PersistentWorkspaceManager({
    getRuntimeConfig: () => ({
      sandboxEnabled: true,
      agentLoopV2Enabled: true,
      sandbox: {
        provider: 'local-docker',
        image,
        rootDir,
        workspaceTtlMs: 60000,
      },
    }),
    provider,
    exporter,
    projectAdapter,
    documentAdapter,
    diffCollector: new ProjectDiffCollector(),
    patchConverter: new PatchToPendingChanges({
      idGenerator: () => 'change-smoke-1',
    }),
    workspacesCollection,
    sessionsCollection,
  })

  let workspaceResult
  try {
    workspaceResult = await manager.ensureWorkspace({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
    })
    await workspaceResult.sandboxSession.writeFile(
      'main.tex',
      'Hello from persistent workspace.\n'
    )

    const result = await manager.syncPendingChanges({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      workspace: workspaceResult.workspace,
    })
    const [change] = result.pendingChanges
    if (result.changeCount !== 1 || !change) {
      throw new Error(`expected one pending change, got ${result.changeCount}`)
    }
    if (change.type !== 'edit' || change.path !== '/main.tex') {
      throw new Error(`unexpected change: ${JSON.stringify(change)}`)
    }
    if (change.oldText !== baseText || change.newText !== 'Hello from persistent workspace.\n') {
      throw new Error('pending change text did not match workspace diff')
    }
    if (sessionsCollection.docs[0].pendingChanges?.[0]?.id !== 'change-smoke-1') {
      throw new Error('pending changes were not written to ai session collection')
    }

    console.log(`workspace id: ${workspaceResult.workspace._id}`)
    console.log('workspace diff: ok')
    console.log(`pending changes: ${result.pendingChanges.map(item => item.id).join(', ')}`)
  } finally {
    if (workspaceResult?.sandboxSession?.id) {
      await provider.destroySession(workspaceResult.sandboxSession.id).catch(() => {})
    }
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
