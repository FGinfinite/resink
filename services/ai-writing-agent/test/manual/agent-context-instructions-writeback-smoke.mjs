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
const DEFAULT_WEB_INTERNAL_URL = 'http://127.0.0.1:13000'
const DEFAULT_WEB_API_USER = 'overleaf'
const DEFAULT_WEB_API_PASSWORD = 'overleaf'

const RUN_MARKER = `agent-context-instructions-writeback-smoke-${Date.now()}`
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
  webInternalUrl: getArg('web-internal-url', DEFAULT_WEB_INTERNAL_URL).replace(/\/$/, ''),
  webApiUser: getArg('web-api-user', DEFAULT_WEB_API_USER),
  webApiPassword: getArg('web-api-password', DEFAULT_WEB_API_PASSWORD),
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

async function apiRequest(page, csrfToken, method, path, data = undefined) {
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
  if (!response.ok()) {
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

async function getInstructions(page, csrfToken) {
  return apiRequest(
    page,
    csrfToken,
    'GET',
    `/projects/${config.projectId.toString()}/agent-instructions`
  )
}

async function createInstructions(page, csrfToken, content) {
  return apiRequest(
    page,
    csrfToken,
    'POST',
    `/projects/${config.projectId.toString()}/agent-instructions/create`,
    { content }
  )
}

async function saveInstructionsDraft(page, csrfToken, payload) {
  return apiRequest(
    page,
    csrfToken,
    'PUT',
    `/projects/${config.projectId.toString()}/agent-instructions/draft`,
    payload
  )
}

async function acceptDraft(page, csrfToken, sessionId, draftChangeId) {
  return apiRequest(
    page,
    csrfToken,
    'POST',
    `/sessions/${sessionId}/changes/${draftChangeId}/accept`
  )
}

async function rejectDraft(page, csrfToken, sessionId, draftChangeId) {
  return apiRequest(
    page,
    csrfToken,
    'POST',
    `/sessions/${sessionId}/changes/${draftChangeId}/reject`
  )
}

async function deleteCreatedInstructions(docId, userId) {
  if (!docId || !userId) return
  const response = await fetch(
    `${config.webInternalUrl}/internal/project/${config.projectId.toString()}/doc/${docId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.webApiUser}:${config.webApiPassword}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId }),
    }
  )
  if (!response.ok && response.status !== 404) {
    throw new Error(`Delete smoke AGENTS.md failed ${response.status}: ${await response.text()}`)
  }
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

async function cleanupSessionRecords(db, sessionId) {
  if (!sessionId) return
  const objectId = new ObjectId(sessionId)
  const changeSets = await (await collection(db, 'aiAgentChangeSets'))
    .find({ sessionId: objectId })
    .toArray()
  const changeSetIds = changeSets.map(changeSet => changeSet._id)
  await Promise.all([
    (await collection(db, 'aiSessions')).deleteOne({ _id: objectId }),
    (await collection(db, 'aiMessages')).deleteMany({ sessionId: objectId }),
    (await collection(db, 'aiAgentChangeSets')).deleteMany({ sessionId: objectId }),
    (await collection(db, 'aiAgentDraftChanges')).deleteMany({ sessionId: objectId }),
    (await collection(db, 'aiAgentApplyOperations')).deleteMany({ sessionId: objectId }),
    changeSetIds.length
      ? (await collection(db, 'aiAgentApplyOperations')).deleteMany({
          changeSetId: { $in: changeSetIds },
        })
      : Promise.resolve(),
  ])
}

async function getDraft(db, sessionId, draftChangeId) {
  return (await collection(db, 'aiAgentDraftChanges')).findOne({
    _id: new ObjectId(draftChangeId),
    sessionId: new ObjectId(sessionId),
  })
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
  let originalInstructions
  let lastSeenInstructions
  let createdInstructionsDuringSmoke = false

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

    originalInstructions = await getInstructions(page, csrfToken)
    if (!originalInstructions.exists) {
      originalInstructions = await createInstructions(
        page,
        csrfToken,
        '# Project Instructions\n\nSmoke baseline.\n'
      )
      createdInstructionsDuringSmoke = true
    }
    lastSeenInstructions = originalInstructions

    const reviewContent = `${originalInstructions.content}\n\n${RUN_MARKER}-review\n`
    const review = await saveInstructionsDraft(page, csrfToken, {
      sessionId,
      docId: originalInstructions.docId,
      baseVersion: originalInstructions.version,
      content: reviewContent,
      mode: 'review',
    })
    if (review.status !== 'pending') {
      throw new Error(`Review draft was not pending: ${JSON.stringify(review)}`)
    }
    const unchangedAfterReview = await getInstructions(page, csrfToken)
    if (unchangedAfterReview.content !== originalInstructions.content) {
      throw new Error('Review draft changed canonical AGENTS.md before accept')
    }

    const accepted = await acceptDraft(
      page,
      csrfToken,
      sessionId,
      review.draftChangeId
    )
    if (!accepted.success) {
      throw new Error(`Accept did not report success: ${JSON.stringify(accepted)}`)
    }
    const acceptedInstructions = await getInstructions(page, csrfToken)
    lastSeenInstructions = acceptedInstructions
    if (!acceptedInstructions.content.includes(`${RUN_MARKER}-review`)) {
      throw new Error('Accepted draft was not written to canonical AGENTS.md')
    }

    const autoContent = `${acceptedInstructions.content}\n${RUN_MARKER}-auto\n`
    const auto = await saveInstructionsDraft(page, csrfToken, {
      sessionId,
      docId: acceptedInstructions.docId,
      baseVersion: acceptedInstructions.version,
      content: autoContent,
      mode: 'auto',
    })
    if (auto.status !== 'accepted' || !auto.appliedVersion) {
      throw new Error(`Auto Accept did not apply immediately: ${JSON.stringify(auto)}`)
    }
    const autoInstructions = await getInstructions(page, csrfToken)
    lastSeenInstructions = autoInstructions
    if (!autoInstructions.content.includes(`${RUN_MARKER}-auto`)) {
      throw new Error('Auto Accept content was not written to canonical AGENTS.md')
    }

    const reject = await saveInstructionsDraft(page, csrfToken, {
      sessionId,
      docId: autoInstructions.docId,
      baseVersion: autoInstructions.version,
      content: `${autoInstructions.content}\n${RUN_MARKER}-reject\n`,
      mode: 'review',
    })
    await rejectDraft(page, csrfToken, sessionId, reject.draftChangeId)
    const afterReject = await getInstructions(page, csrfToken)
    lastSeenInstructions = afterReject
    if (afterReject.content.includes(`${RUN_MARKER}-reject`)) {
      throw new Error('Rejected draft leaked into canonical AGENTS.md')
    }

    const staleResponse = await page.request.fetch(
      `${config.baseUrl}/api/ai/projects/${config.projectId.toString()}/agent-instructions/draft`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Csrf-Token': csrfToken,
        },
        data: {
          sessionId,
          docId: afterReject.docId,
          baseVersion: Math.max(0, afterReject.version - 1),
          content: `${afterReject.content}\n${RUN_MARKER}-stale\n`,
          mode: 'review',
        },
      }
    )
    if (staleResponse.status() !== 409) {
      throw new Error(
        `Expected stale baseVersion to return 409, got ${staleResponse.status()}: ${await staleResponse.text()}`
      )
    }

    const restore = await saveInstructionsDraft(page, csrfToken, {
      sessionId,
      docId: afterReject.docId,
      baseVersion: afterReject.version,
      content: originalInstructions.content,
      mode: 'auto',
    })
    if (restore.status !== 'accepted') {
      throw new Error(`Restore Auto Accept did not apply: ${JSON.stringify(restore)}`)
    }
    const restored = await getInstructions(page, csrfToken)
    lastSeenInstructions = restored
    if (restored.content !== originalInstructions.content) {
      throw new Error('AGENTS.md restore did not return the original content')
    }
    if (createdInstructionsDuringSmoke) {
      await deleteCreatedInstructions(restored.docId, user._id.toString())
    }

    const reviewDraft = await getDraft(db, sessionId, review.draftChangeId)
    const autoDraft = await getDraft(db, sessionId, auto.draftChangeId)
    if (reviewDraft?.status !== 'accepted') {
      throw new Error('Accepted review draft was not persisted as accepted')
    }
    if (autoDraft?.status !== 'accepted') {
      throw new Error('Auto Accept draft was not persisted as accepted')
    }

    await browser.close()
    browser = null
    await cleanupSessionRecords(db, sessionId)
    await restorePassword(db, user, originalHash, smokeHash)
    originalHash = null
    smokeHash = null

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      sessionId,
      path: restored.path,
      docId: restored.docId,
      beforeVersion: originalInstructions.version,
      acceptedVersion: acceptedInstructions.version,
      autoVersion: autoInstructions.version,
      restoredVersion: restored.version,
      deletedCreatedInstructions: createdInstructionsDuringSmoke,
      reviewDraftId: review.draftChangeId,
      autoDraftId: auto.draftChangeId,
      staleConflictStatus: staleResponse.status(),
      pathVerified:
        'browser login -> web proxy /api/ai -> ai-writing-agent -> AGENTS.md draft changes -> canonical CAS writeback',
    }, null, 2))
  } catch (error) {
    if (originalInstructions && lastSeenInstructions && browser) {
      try {
        const page = browser.contexts()[0]?.pages()[0]
        const csrfToken = page
          ? await page.locator('meta[name="ol-csrfToken"]').getAttribute('content')
          : null
        if (
          page &&
          csrfToken &&
          lastSeenInstructions.content !== originalInstructions.content
        ) {
          await saveInstructionsDraft(page, csrfToken, {
            sessionId,
            docId: lastSeenInstructions.docId,
            baseVersion: lastSeenInstructions.version,
            content: originalInstructions.content,
            mode: 'auto',
          })
        }
      } catch (restoreError) {
        console.error(`WARN: failed to restore AGENTS.md: ${restoreError.message}`)
      }
    }
    if (createdInstructionsDuringSmoke && lastSeenInstructions?.docId && user?._id) {
      await deleteCreatedInstructions(
        lastSeenInstructions.docId,
        user._id.toString()
      ).catch(restoreError => {
        console.error(`WARN: failed to delete smoke AGENTS.md: ${restoreError.message}`)
      })
    }
    if (browser) await browser.close().catch(() => {})
    throw error
  } finally {
    if (sessionId) await cleanupSessionRecords(db, sessionId).catch(() => {})
    if (user) await restorePassword(db, user, originalHash, smokeHash).catch(() => {})
    await releaseLock?.()
    await client.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
