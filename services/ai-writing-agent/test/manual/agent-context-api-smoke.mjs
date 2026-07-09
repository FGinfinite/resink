#!/usr/bin/env node

/* eslint-disable import/no-extraneous-dependencies, no-console */

import { chromium } from 'playwright'
import { MongoClient, ObjectId } from 'mongodb'
import bcrypt from 'bcryptjs'

const DEFAULT_BASE_URL = 'http://127.0.0.1:18080'
const DEFAULT_MONGO_URL =
  'mongodb://127.0.0.1:37017/sharelatex?directConnection=true'
const DEFAULT_EMAIL = 'agent-smoke@example.com'
const DEFAULT_PASSWORD = 'AgentSmoke123!'
const DEFAULT_PROJECT_ID = '6a390bf87a13c32e536c279c'
const DEFAULT_DOC_ID = '6a390bf87a13c32e536c27a1'

const RUN_MARKER = `agent-context-api-smoke-${Date.now()}`
const SMOKE_USER_LOCK_ID = 'agent-smoke-user-password'
const SMOKE_USER_LOCK_TTL_MS = 10 * 60_000

function getArg(name, fallback) {
  const prefix = `--${name}=`
  const match = process.argv.find(arg => arg.startsWith(prefix))
  const envName = name.toUpperCase().replaceAll('-', '_')
  return match ? match.slice(prefix.length) : process.env[envName] || fallback
}

const config = {
  baseUrl: getArg('base-url', DEFAULT_BASE_URL).replace(/\/$/, ''),
  mongoUrl: getArg('mongo-url', DEFAULT_MONGO_URL),
  email: getArg('email', DEFAULT_EMAIL),
  password: getArg('password', DEFAULT_PASSWORD),
  projectId: new ObjectId(getArg('project-id', DEFAULT_PROJECT_ID)),
  docId: new ObjectId(getArg('doc-id', DEFAULT_DOC_ID)),
  headed: process.argv.includes('--headed'),
}

async function collection(db, name) {
  return db.collection(name)
}

async function acquireSmokeUserLock(db) {
  const locks = await collection(db, 'aiAgentManualSmokeLocks')
  const owner = RUN_MARKER
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await locks.insertOne({
        _id: SMOKE_USER_LOCK_ID,
        owner,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + SMOKE_USER_LOCK_TTL_MS),
      })
      return async () => {
        await locks.deleteOne({ _id: SMOKE_USER_LOCK_ID, owner }).catch(() => {})
      }
    } catch (error) {
      if (error.code !== 11000) throw error
      await locks.deleteOne({
        _id: SMOKE_USER_LOCK_ID,
        expiresAt: { $lt: new Date() },
      })
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  throw new Error('Timed out waiting for smoke user password lock')
}

async function login(page) {
  await page.goto(`${config.baseUrl}/login`, { waitUntil: 'domcontentloaded' })
  const csrf = await page.locator('input[name="_csrf"]').inputValue()
  const response = await page.request.post(`${config.baseUrl}/login`, {
    form: { _csrf: csrf, email: config.email, password: config.password },
    maxRedirects: 0,
  })
  if (![200, 302].includes(response.status())) {
    throw new Error(`Login failed with status ${response.status()}: ${await response.text()}`)
  }
}

async function getCsrfToken(page) {
  await page.goto(`${config.baseUrl}/project/${config.projectId.toString()}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  const token = await page.locator('meta[name="ol-csrfToken"]').getAttribute('content')
  if (!token) throw new Error('Could not read ol-csrfToken from project page')
  return token
}

async function apiRequest(page, csrfToken, method, path, data = undefined, ok = [200, 201]) {
  const response = await page.request.fetch(`${config.baseUrl}/api/ai${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Csrf-Token': csrfToken,
    },
    data,
  })
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!ok.includes(response.status())) {
    throw new Error(`HTTP ${response.status()} ${method} ${path}: ${text}`)
  }
  return { status: response.status(), body }
}

async function createSession(page, csrfToken) {
  const { body } = await apiRequest(page, csrfToken, 'POST', '/sessions', {
    projectId: config.projectId.toString(),
    docId: config.docId.toString(),
    runtimeMode: 'agent-loop-v2',
  })
  return body.session.id
}

async function restorePassword(db, user, originalHash, smokeHash) {
  if (!user || !originalHash || !smokeHash) return
  await (await collection(db, 'users')).updateOne(
    { _id: user._id, hashedPassword: smokeHash },
    { $set: { hashedPassword: originalHash } }
  )
}

async function cleanup(db, sessionId) {
  const sessionObjectId = sessionId ? new ObjectId(sessionId) : null
  await Promise.all([
    sessionObjectId
      ? (await collection(db, 'aiSessions')).deleteOne({ _id: sessionObjectId })
      : Promise.resolve(),
    sessionObjectId
      ? (await collection(db, 'aiMessages')).deleteMany({ sessionId: sessionObjectId })
      : Promise.resolve(),
    sessionObjectId
      ? (await collection(db, 'aiContextSnapshots')).deleteMany({ sessionId })
      : Promise.resolve(),
    sessionObjectId
      ? (await collection(db, 'aiSessionSummaries')).deleteMany({ sessionId })
      : Promise.resolve(),
    (await collection(db, 'aiMemories')).deleteMany({
      content: { $regex: RUN_MARKER },
    }),
    (await collection(db, 'aiMemorySuggestions')).deleteMany({
      proposedContent: { $regex: RUN_MARKER },
    }),
  ])
}

async function main() {
  const client = await MongoClient.connect(config.mongoUrl)
  const db = client.db()
  let browser
  let user
  let originalHash
  let smokeHash
  let releaseLock
  let sessionId

  try {
    releaseLock = await acquireSmokeUserLock(db)
    user = await (await collection(db, 'users')).findOne({ email: config.email })
    if (!user) throw new Error(`Missing smoke user ${config.email}`)
    originalHash = user.hashedPassword
    smokeHash = bcrypt.hashSync(config.password, 12)
    await (await collection(db, 'users')).updateOne(
      { _id: user._id },
      {
        $set: {
          hashedPassword: smokeHash,
          analyticsId: user.analyticsId || user._id.toString(),
        },
      }
    )

    browser = await chromium.launch({ headless: !config.headed })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await login(page)
    const csrfToken = await getCsrfToken(page)
    sessionId = await createSession(page, csrfToken)
    const userId = user._id.toString()

    const memoryContent = `${RUN_MARKER} project memory`
    const createdMemory = await apiRequest(page, csrfToken, 'POST', '/memories', {
      content: memoryContent,
      scope: 'project',
      projectId: config.projectId.toString(),
      tags: ['smoke'],
    })
    const memoryId = createdMemory.body.memory.id
    const listed = await apiRequest(
      page,
      csrfToken,
      'GET',
      `/memories?projectId=${config.projectId.toString()}&scope=all`
    )
    if (!listed.body.memories.some(memory => memory.id === memoryId)) {
      throw new Error('Created memory was not listed for owning user')
    }

    await (await collection(db, 'aiMemories')).insertOne({
      _id: new ObjectId(),
      userId: new ObjectId().toString(),
      projectId: config.projectId.toString(),
      scope: 'project',
      content: `${RUN_MARKER} other user memory`,
      status: 'active',
      source: 'manual',
      tags: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const privateCheck = await apiRequest(
      page,
      csrfToken,
      'GET',
      `/memories?projectId=${config.projectId.toString()}&scope=all`
    )
    if (privateCheck.body.memories.some(memory => memory.content.includes('other user'))) {
      throw new Error('Memories API leaked another user memory')
    }

    const suggestionId = new ObjectId()
    await (await collection(db, 'aiMemorySuggestions')).insertOne({
      _id: suggestionId,
      userId,
      projectId: config.projectId.toString(),
      sessionId,
      messageId: null,
      proposedContent: `${RUN_MARKER} suggestion`,
      scope: 'project',
      reason: 'smoke',
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      acceptedAt: null,
      dismissedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      memoryId: null,
    })
    const suggestions = await apiRequest(
      page,
      csrfToken,
      'GET',
      `/memory-suggestions?projectId=${config.projectId.toString()}`
    )
    if (!suggestions.body.suggestions.some(suggestion => suggestion.id === suggestionId.toString())) {
      throw new Error('Memory suggestion was not listed')
    }
    const accepted = await apiRequest(
      page,
      csrfToken,
      'POST',
      `/memory-suggestions/${suggestionId.toString()}/accept`
    )
    if (!accepted.body.memory?.id) {
      throw new Error('Accept suggestion did not create memory')
    }

    await (await collection(db, 'aiContextSnapshots')).insertOne({
      _id: new ObjectId(),
      sessionId,
      projectId: config.projectId.toString(),
      userId,
      turnId: 'turn-smoke',
      messageId: null,
      sourceRefs: [
        {
          type: 'memory',
          refId: memoryId,
          path: null,
          scope: 'project',
          tokenEstimate: 4,
          included: true,
          reason: 'smoke',
        },
      ],
      totals: {
        sourceCount: 1,
        tokenEstimate: 4,
        memoryCount: 1,
        recalledCount: 0,
      },
      createdAt: new Date(),
      hiddenPrompt: 'must not be returned',
    })
    const snapshot = await apiRequest(
      page,
      csrfToken,
      'GET',
      `/sessions/${sessionId}/context-snapshot/turn-smoke`
    )
    if (JSON.stringify(snapshot.body).includes('must not be returned')) {
      throw new Error('Context snapshot leaked hidden prompt')
    }
    if (snapshot.body.snapshot?.totals?.memoryCount !== 1) {
      throw new Error('Context snapshot response missing totals')
    }

    await (await collection(db, 'aiSessionSummaries')).insertOne({
      _id: new ObjectId(),
      sessionId,
      projectId: config.projectId.toString(),
      userId,
      summary: `${RUN_MARKER} session summary`,
      sourceMessageRange: { fromSeq: 1, toSeq: 1 },
      tokenEstimate: 5,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      supersededAt: null,
    })
    const summary = await apiRequest(
      page,
      csrfToken,
      'GET',
      `/sessions/${sessionId}/session-summary`
    )
    if (!summary.body.summary?.summary?.includes(RUN_MARKER)) {
      throw new Error('Session summary response missing latest summary')
    }

    const deleted = await apiRequest(
      page,
      csrfToken,
      'DELETE',
      `/memories/${memoryId}`
    )
    if (deleted.body.memory.status !== 'deleted') {
      throw new Error('Delete memory did not soft-delete memory')
    }

    await browser.close()
    browser = null
    await cleanup(db, sessionId)
    await restorePassword(db, user, originalHash, smokeHash)
    originalHash = null
    smokeHash = null

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      sessionId,
      memoryId,
      suggestionId: suggestionId.toString(),
      acceptedMemoryId: accepted.body.memory.id,
      pathVerified:
        'browser login -> web proxy /api/ai -> agent context memory/suggestion/trace APIs',
    }, null, 2))
  } catch (error) {
    if (browser) await browser.close().catch(() => {})
    throw error
  } finally {
    if (sessionId) {
      await cleanup(db, sessionId).catch(() => {})
    }
    if (user) await restorePassword(db, user, originalHash, smokeHash).catch(() => {})
    await releaseLock?.()
    await client.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
