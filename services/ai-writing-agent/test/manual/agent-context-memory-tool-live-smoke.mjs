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

const RUN_MARKER = `agent-context-memory-tool-live-smoke-${Date.now()}`
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
  const body = text ? JSON.parse(text) : null
  if (!ok.includes(response.status())) {
    throw new Error(`HTTP ${response.status()} ${method} ${path}: ${text}`)
  }
  return body
}

async function createSession(page, csrfToken) {
  const body = await apiRequest(page, csrfToken, 'POST', '/sessions', {
    projectId: config.projectId.toString(),
    docId: config.docId.toString(),
    runtimeMode: 'agent-loop-v2',
  })
  return body.session.id
}

function parseSSE(text) {
  return text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(data => data && data !== '[DONE]')
    .map(data => {
      try {
        return JSON.parse(data)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function sendMemoryProposalMessage(page, csrfToken, sessionId) {
  const proposedContent = `${RUN_MARKER} always prefer concise Chinese progress updates`
  const response = await page.request.post(
    `${config.baseUrl}/api/ai/sessions/${sessionId}/messages`,
    {
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
        'X-Csrf-Token': csrfToken,
        Accept: 'text/event-stream',
      },
      data: {
        content: [
          'Call propose_memory exactly once.',
          `Use proposedContent exactly: ${JSON.stringify(proposedContent)}.`,
          'Use scope "project".',
          'Use reason exactly: "live smoke requested a durable project preference".',
          'After the tool result, answer exactly: memory proposal smoke done.',
        ].join('\n'),
        context: {
          currentDocId: config.docId.toString(),
          currentDocPath: '/main.tex',
          autoAccept: false,
        },
        stream: true,
      },
    }
  )
  const body = await response.text()
  if (response.status() !== 200) {
    throw new Error(`Send message failed ${response.status()}: ${body}`)
  }
  return { events: parseSSE(body), proposedContent }
}

async function restorePassword(db, user, originalHash, smokeHash) {
  if (!user || !originalHash || !smokeHash) return
  const result = await (await collection(db, 'users')).updateOne(
    { _id: user._id, hashedPassword: smokeHash },
    { $set: { hashedPassword: originalHash } }
  )
  if (result.modifiedCount === 0) {
    const currentUser = await (await collection(db, 'users')).findOne(
      { _id: user._id },
      { projection: { hashedPassword: 1 } }
    )
    if (currentUser?.hashedPassword !== originalHash) {
      console.warn(
        'WARN: smoke user password changed during run; not overwriting concurrent hash update'
      )
    }
  }
}

async function cleanup(db, sessionId, userId) {
  const sessionObjectId = sessionId ? new ObjectId(sessionId) : null
  await Promise.all([
    sessionObjectId
      ? (await collection(db, 'aiSessions')).deleteOne({ _id: sessionObjectId })
      : Promise.resolve(),
    sessionObjectId
      ? (await collection(db, 'aiMessages')).deleteMany({ sessionId: sessionObjectId })
      : Promise.resolve(),
    sessionId
      ? (await collection(db, 'aiContextSnapshots')).deleteMany({ sessionId })
      : Promise.resolve(),
    sessionId
      ? (await collection(db, 'aiSessionSummaries')).deleteMany({ sessionId })
      : Promise.resolve(),
    (await collection(db, 'aiMemories')).deleteMany({
      userId,
      content: { $regex: RUN_MARKER },
    }),
    (await collection(db, 'aiMemorySuggestions')).deleteMany({
      userId,
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

    const { events, proposedContent } = await sendMemoryProposalMessage(
      page,
      csrfToken,
      sessionId
    )
    const proposed = events.find(
      event => event.type === 'tool_call' &&
        event.toolCall?.function?.name === 'propose_memory'
    )
    if (!proposed) {
      throw new Error(`Live model did not call propose_memory; events=${events.map(event => event.type).join(', ')}`)
    }
    if (!events.some(event => event.type === 'message_complete')) {
      throw new Error('Live model path did not complete')
    }

    const suggestion = await (await collection(db, 'aiMemorySuggestions')).findOne({
      userId,
      sessionId,
      proposedContent,
      status: 'pending',
    })
    if (!suggestion) throw new Error('propose_memory did not create pending suggestion')

    const accepted = await apiRequest(
      page,
      csrfToken,
      'POST',
      `/memory-suggestions/${suggestion._id.toString()}/accept`
    )
    if (accepted.memory.content !== proposedContent) {
      throw new Error('Accepting proposed memory created unexpected content')
    }

    const listed = await apiRequest(
      page,
      csrfToken,
      'GET',
      `/memories?projectId=${config.projectId.toString()}&scope=all`
    )
    if (!listed.memories.some(memory => memory.id === accepted.memory.id)) {
      throw new Error('Accepted memory was not listed for owning user')
    }

    await browser.close()
    browser = null
    await cleanup(db, sessionId, userId)
    await restorePassword(db, user, originalHash, smokeHash)
    originalHash = null
    smokeHash = null

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      sessionId,
      suggestionId: suggestion._id.toString(),
      memoryId: accepted.memory.id,
      pathVerified:
        'browser login -> web proxy -> live AgentLoopV2 -> propose_memory tool -> suggestion accept -> memory list',
    }, null, 2))
  } catch (error) {
    if (browser) await browser.close().catch(() => {})
    throw error
  } finally {
    if (sessionId && user?._id) {
      await cleanup(db, sessionId, user._id.toString()).catch(() => {})
    }
    if (user) await restorePassword(db, user, originalHash, smokeHash).catch(() => {})
    await releaseLock?.()
    await client.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
