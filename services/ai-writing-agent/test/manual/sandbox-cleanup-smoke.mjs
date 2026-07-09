#!/usr/bin/env node

/* eslint-disable no-console */

import fs from 'node:fs/promises'
import { MongoClient, ObjectId } from 'mongodb'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_IMAGE = 'resink-ai-sandbox:dev'
const DEFAULT_MONGO_URL =
  'mongodb://127.0.0.1:37017/sharelatex?directConnection=true'
const DEFAULT_PROJECT_ID = '6a390bf87a13c32e536c279c'
const DEFAULT_USER_ID = '6a390bf87a13c32e536c279b'
const RUN_MARKER = `sandbox-cleanup-smoke-${Date.now()}`
const SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function getArg(name, fallback) {
  const prefix = `--${name}=`
  const match = process.argv.find(arg => arg.startsWith(prefix))
  const envName = name.toUpperCase().replaceAll('-', '_')
  return match ? match.slice(prefix.length) : process.env[envName] || fallback
}

const config = {
  image: getArg('image', DEFAULT_IMAGE),
  dockerBin: getArg('docker-bin', 'docker'),
  mongoUrl: getArg('mongo-url', DEFAULT_MONGO_URL),
  projectId: getArg('project-id', DEFAULT_PROJECT_ID),
  userId: getArg('user-id', DEFAULT_USER_ID),
  keepRoot: process.argv.includes('--keep-root'),
}

async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function runDocker(args) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    const child = spawn(config.dockerBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', exitCode => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

async function assertContainerAbsent(name) {
  const result = await runDocker([
    'ps',
    '-a',
    '--filter',
    `name=^/${name}$`,
    '--format',
    '{{.Names}}',
  ])
  if (result.exitCode !== 0) {
    throw new Error(`docker ps failed: ${result.stderr}`)
  }
  if (result.stdout.trim()) {
    throw new Error(`Sandbox container still exists after cleanup: ${result.stdout.trim()}`)
  }
}

function createScopedWorkspacesCollection(collection, workspaceId) {
  const scope = query => ({ ...query, _id: workspaceId })
  return {
    find(query) {
      return collection.find(scope(query))
    },
    updateOne(filter, update, options) {
      return collection.updateOne(scope(filter), update, options)
    },
  }
}

async function main() {
  process.chdir(SERVICE_ROOT)
  const { LocalDockerSandboxProvider } = await import('../../app/js/sandbox/LocalDockerSandboxProvider.js')
  const { PersistentWorkspaceManager } = await import('../../app/js/sandbox/PersistentWorkspaceManager.js')

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-cleanup-smoke-'))
  const client = await MongoClient.connect(config.mongoUrl)
  const db = client.db()
  const dockerProvider = new LocalDockerSandboxProvider({
    image: config.image,
    dockerBin: config.dockerBin,
    rootDir,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    maxArtifactBytes: 1024 * 1024,
    maxFileCount: 1000,
    networkPolicy: 'deny',
    memoryBytes: 256 * 1024 * 1024,
    memorySwapBytes: 256 * 1024 * 1024,
    cpuCount: 1,
    pidsLimit: 128,
  })
  let session
  let workspaceId
  let aiSessionId

  try {
    aiSessionId = new ObjectId()
    workspaceId = `workspace-${RUN_MARKER}`
    await db.collection('aiSessions').insertOne({
      _id: aiSessionId,
      projectId: new ObjectId(config.projectId),
      userId: config.userId,
      title: `Sandbox cleanup smoke ${RUN_MARKER}`,
      smokeMarker: RUN_MARKER,
      status: 'active',
      workspaceId,
      workspaceStatus: 'ready',
      workspaceUpdatedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection('aiAgentWorkspaces').insertOne({
      _id: workspaceId,
      sessionId: aiSessionId.toString(),
      projectId: config.projectId,
      userId: config.userId,
      status: 'ready',
      provider: 'local-docker',
      providerSessionId: workspaceId,
      workspacePath: path.join(rootDir, workspaceId, 'workspace'),
      expiresAt: new Date(Date.now() - 60_000),
      createdAt: new Date(Date.now() - 120_000),
      updatedAt: new Date(Date.now() - 120_000),
    })
    let destroyedExpiredWorkspace = null
    const workspaceManager = new PersistentWorkspaceManager({
      workspacesCollection: createScopedWorkspacesCollection(
        db.collection('aiAgentWorkspaces'),
        workspaceId
      ),
      sessionsCollection: db.collection('aiSessions'),
      provider: {
        async destroySession(providerSessionId, providerState) {
          destroyedExpiredWorkspace = { providerSessionId, providerState }
        },
      },
      now: () => new Date(),
    })
    const expiredCleanup = await workspaceManager.cleanupExpired()
    if (!expiredCleanup.removedWorkspaces.includes(workspaceId)) {
      throw new Error(
        `Expired workspace cleanup did not remove ${workspaceId}: ${JSON.stringify(expiredCleanup)}`
      )
    }
    const expiredWorkspace = await db.collection('aiAgentWorkspaces').findOne({ _id: workspaceId })
    if (expiredWorkspace?.status !== 'expired') {
      throw new Error(`Expired workspace status was not updated: ${expiredWorkspace?.status}`)
    }
    if (destroyedExpiredWorkspace?.providerSessionId !== workspaceId) {
      throw new Error(
        `Expired workspace provider cleanup was not called: ${JSON.stringify(destroyedExpiredWorkspace)}`
      )
    }
    const expiredSession = await db.collection('aiSessions').findOne({ _id: aiSessionId })
    if (
      expiredSession?.workspaceStatus !== 'expired' ||
      expiredSession?.workspaceId
    ) {
      throw new Error(
        `Session workspace state was not expired: ${JSON.stringify({
          workspaceStatus: expiredSession?.workspaceStatus,
          workspaceId: expiredSession?.workspaceId,
        })}`
      )
    }

    session = await dockerProvider.createSession({ id: RUN_MARKER })
    const workspaceParent = path.dirname(session.workspacePath)
    if (!(await pathExists(workspaceParent))) {
      throw new Error(`Workspace parent missing before cleanup: ${workspaceParent}`)
    }
    const containerBefore = await runDocker([
      'ps',
      '-a',
      '--filter',
      `name=^/${session.containerName}$`,
      '--format',
      '{{.Names}}',
    ])
    if (containerBefore.exitCode !== 0 || containerBefore.stdout.trim() !== session.containerName) {
      throw new Error(
        `Sandbox container missing before cleanup: stdout=${containerBefore.stdout} stderr=${containerBefore.stderr}`
      )
    }

    const cleanup = await dockerProvider.manualCleanup({
      includeActive: true,
      removeWorkspaces: true,
    })
    if (!cleanup.removedContainers.includes(session.containerName)) {
      throw new Error(
        `Cleanup did not remove active container ${session.containerName}: ${JSON.stringify(cleanup)}`
      )
    }
    if (!cleanup.removedWorkspaces.includes(workspaceParent)) {
      throw new Error(
        `Cleanup did not remove workspace ${workspaceParent}: ${JSON.stringify(cleanup)}`
      )
    }
    await assertContainerAbsent(session.containerName)
    if (await pathExists(workspaceParent)) {
      throw new Error(`Workspace parent still exists after cleanup: ${workspaceParent}`)
    }

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      image: config.image,
      expiredWorkspaceId: workspaceId,
      expiredWorkspaceCleanup: expiredCleanup,
      containerName: session.containerName,
      rootDir,
      removedContainers: cleanup.removedContainers,
      removedWorkspaces: cleanup.removedWorkspaces,
    }, null, 2))
  } catch (error) {
    if (session) {
      await dockerProvider.destroySession(session.id).catch(() => {})
    }
    throw error
  } finally {
    if (workspaceId) {
      await db.collection('aiAgentWorkspaces').deleteMany({ _id: workspaceId }).catch(() => {})
    }
    if (aiSessionId) {
      await db.collection('aiSessions').deleteMany({ _id: aiSessionId }).catch(() => {})
    }
    await client.close()
    if (!config.keepRoot) {
      await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
