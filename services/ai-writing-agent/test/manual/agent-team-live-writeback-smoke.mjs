#!/usr/bin/env node

/* eslint-disable import/no-extraneous-dependencies, no-console */

import { chromium } from 'playwright'
import { MongoClient, ObjectId } from 'mongodb'
import bcrypt from 'bcryptjs'

const DEFAULT_BASE_URL = 'http://127.0.0.1:18080'
const DEFAULT_DOCUMENT_UPDATER_URL = 'http://127.0.0.1:3003'
const DEFAULT_MONGO_URL =
  'mongodb://127.0.0.1:37017/sharelatex?directConnection=true'
const DEFAULT_EMAIL = 'agent-smoke@example.com'
const DEFAULT_PASSWORD = 'AgentSmoke123!'
const DEFAULT_PROJECT_ID = '6a390bf87a13c32e536c279c'
const DEFAULT_DOC_ID = '6a390bf87a13c32e536c27a1'
const DEFAULT_DOC_PATH = '/main.tex'

const RUN_MARKER = `agent-team-live-writeback-smoke-${Date.now()}`
const SMOKE_USER_LOCK_ID = 'agent-smoke-user-password'
const SMOKE_USER_LOCK_TTL_MS = 10 * 60_000
const FORBIDDEN_TOOL_NAMES = new Set([
  'start_agent_task',
  'start_agent_team',
  'handoff_to_agent',
  'return_from_handoff',
  'run_command',
  'write_workspace_file',
  'run_skill_script',
])

function getArg(name, fallback) {
  const prefix = `--${name}=`
  const match = process.argv.find(arg => arg.startsWith(prefix))
  const envName = name.toUpperCase().replaceAll('-', '_')
  return match ? match.slice(prefix.length) : process.env[envName] || fallback
}

const config = {
  baseUrl: getArg('base-url', DEFAULT_BASE_URL).replace(/\/$/, ''),
  documentUpdaterUrl: getArg(
    'document-updater-url',
    DEFAULT_DOCUMENT_UPDATER_URL
  ).replace(/\/$/, ''),
  mongoUrl: getArg('mongo-url', DEFAULT_MONGO_URL),
  email: getArg('email', DEFAULT_EMAIL),
  password: getArg('password', DEFAULT_PASSWORD),
  projectId: new ObjectId(getArg('project-id', DEFAULT_PROJECT_ID)),
  docId: new ObjectId(getArg('doc-id', DEFAULT_DOC_ID)),
  docPath: getArg('doc-path', DEFAULT_DOC_PATH),
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

async function createSession(page, csrfToken) {
  const response = await page.request.post(`${config.baseUrl}/api/ai/sessions`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Csrf-Token': csrfToken,
    },
    data: {
      projectId: config.projectId.toString(),
      docId: config.docId.toString(),
    },
  })
  if (response.status() !== 201) {
    throw new Error(`Create session failed ${response.status()}: ${await response.text()}`)
  }
  const body = await response.json()
  return body.session.id
}

async function readDocument() {
  const response = await fetch(
    `${config.documentUpdaterUrl}/project/${config.projectId.toString()}/doc/${config.docId.toString()}`
  )
  if (!response.ok) {
    throw new Error(`Read document failed ${response.status}: ${await response.text()}`)
  }
  return response.json()
}

async function restoreDocument(originalDoc, userId) {
  const live = await readDocument()
  const response = await fetch(
    `${config.documentUpdaterUrl}/project/${config.projectId.toString()}/doc/${config.docId.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines: originalDoc.lines,
        source: { kind: 'ai-agent-live-writeback-smoke-restore' },
        user_id: userId,
        expected_version: live.version,
      }),
    }
  )
  if (!response.ok) {
    throw new Error(`Restore document failed ${response.status}: ${await response.text()}`)
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
    (await collection(db, 'aiAgentTasks')).deleteMany({ rootSessionId: objectId }),
    (await collection(db, 'aiAgentTeams')).deleteMany({ rootSessionId: objectId }),
    (await collection(db, 'aiAgentTeamEvents')).deleteMany({ sessionId: objectId }),
    changeSetIds.length
      ? (await collection(db, 'aiAgentApplyOperations')).deleteMany({
          changeSetId: { $in: changeSetIds },
        })
      : Promise.resolve(),
  ])
}

async function assertNoSessionResidue(db, sessionId) {
  const objectId = new ObjectId(sessionId)
  const checks = {
    aiSessions: await (await collection(db, 'aiSessions')).countDocuments({ _id: objectId }),
    aiMessages: await (await collection(db, 'aiMessages')).countDocuments({ sessionId: objectId }),
    aiAgentChangeSets: await (await collection(db, 'aiAgentChangeSets')).countDocuments({
      sessionId: objectId,
    }),
    aiAgentDraftChanges: await (await collection(db, 'aiAgentDraftChanges')).countDocuments({
      sessionId: objectId,
    }),
    aiAgentApplyOperations: await (await collection(db, 'aiAgentApplyOperations')).countDocuments({
      sessionId: objectId,
    }),
    aiAgentTeams: await (await collection(db, 'aiAgentTeams')).countDocuments({
      rootSessionId: objectId,
    }),
    aiAgentTasks: await (await collection(db, 'aiAgentTasks')).countDocuments({
      rootSessionId: objectId,
    }),
    aiAgentTeamEvents: await (await collection(db, 'aiAgentTeamEvents')).countDocuments({
      sessionId: objectId,
    }),
  }
  const residue = Object.entries(checks).filter(([, count]) => count !== 0)
  if (residue.length) {
    throw new Error(`Live writeback smoke cleanup left residue: ${JSON.stringify(checks)}`)
  }
  return checks
}

async function sendLiveAutoAcceptEdit(page, csrfToken, sessionId, originalContent) {
  const replacement = `${RUN_MARKER}\n`
  const prompt = [
    `Read ${config.docPath}.`,
    'Then call edit_document exactly once.',
    `Replace the entire current document text ${JSON.stringify(originalContent)} with exactly ${JSON.stringify(replacement)}.`,
    'Do not call start_agent_task, start_agent_team, handoff_to_agent, run_command, or any other team/shell tool.',
    'After the edit tool result, answer with exactly done.',
  ].join(' ')

  const requiredTypes = [
    'tool_call',
    'draft_change.created',
    'canonical_change.applying',
    'canonical_change.applied',
    'draft_change.accepted',
    'tool_result',
  ]
  const result = await page.evaluate(
    async ({ url, csrfToken: token, payload, required, timeoutMs }) => {
      const controller = new AbortController()
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      const events = []
      const seenTypes = new Set()
      const confirmedChanges = new Set()
      let buffer = ''

      function complete() {
        return required.every(type => seenTypes.has(type))
      }

      function consumeSSE(text) {
        buffer += text.replace(/\r\n/g, '\n')
        for (;;) {
          const boundary = buffer.indexOf('\n\n')
          if (boundary === -1) return
          const rawEvent = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = rawEvent
            .split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.replace(/^data:\s?/, ''))
            .join('\n')
            .trim()
          if (!data || data === '[DONE]') continue
          try {
            const event = JSON.parse(data)
            events.push(event)
            if (event?.type) seenTypes.add(event.type)
          } catch {
            // Ignore non-JSON keepalive chunks.
          }
        }
      }

      async function confirmAwaitingChanges() {
        const awaiting = events.filter(event => event?.type === 'awaiting_confirmation')
        for (const event of awaiting) {
          const changeId = event.change?.id
          if (!changeId || confirmedChanges.has(changeId)) continue
          confirmedChanges.add(changeId)
          const confirmResponse = await fetch(
            `${url.replace(/\/messages$/, '')}/confirm-change/${changeId}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Csrf-Token': token,
              },
              body: JSON.stringify({ action: 'accept' }),
              credentials: 'same-origin',
            }
          )
          if (!confirmResponse.ok) {
            events.push({
              type: 'smoke.confirm_failed',
              changeId,
              status: confirmResponse.status,
              body: await confirmResponse.text(),
            })
          }
        }
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Csrf-Token': token,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          signal: controller.signal,
        })
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            body: await response.text(),
            events,
            timedOut,
          }
        }
        if (!response.body) {
          return {
            ok: false,
            status: response.status,
            body: 'Streaming response did not expose a readable body',
            events,
            timedOut,
          }
        }

        const decoder = new TextDecoder()
        const reader = response.body.getReader()
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          consumeSSE(decoder.decode(value, { stream: true }))
          await confirmAwaitingChanges()
          if (complete()) {
            await reader.cancel().catch(() => {})
            break
          }
        }
        consumeSSE(decoder.decode())
        await confirmAwaitingChanges()
        return {
          ok: true,
          status: response.status,
          events,
          timedOut,
        }
      } catch (error) {
        if (error?.name === 'AbortError' && complete()) {
          return {
            ok: true,
            status: 200,
            events,
            timedOut,
          }
        }
        return {
          ok: false,
          status: 0,
          body: `${error?.name || 'Error'}: ${error?.message || String(error)}`,
          events,
          timedOut,
        }
      } finally {
        clearTimeout(timeout)
      }
    },
    {
      url: `${config.baseUrl}/api/ai/sessions/${sessionId}/messages`,
      csrfToken,
      timeoutMs: 120000,
      required: requiredTypes,
      payload: {
        content: prompt,
        context: {
          currentDocId: config.docId.toString(),
          currentDocPath: config.docPath,
          autoAccept: true,
        },
        stream: true,
      },
    }
  )
  if (!result.ok || result.status !== 200) {
    const types = result.events.map(event => event.type).join(', ')
    throw new Error(
      `Send message failed ${result.status}: ${result.body}; saw events: ${types}`
    )
  }
  const confirmationFailure = result.events.find(
    event => event.type === 'smoke.confirm_failed'
  )
  if (confirmationFailure) {
    throw new Error(`Auto-confirm failed: ${JSON.stringify(confirmationFailure)}`)
  }
  requireEventTypes(result.events, requiredTypes)
  return result.events
}

function requireEventTypes(events, expectedTypes) {
  const types = events.map(event => event.type)
  for (const expected of expectedTypes) {
    if (!types.includes(expected)) {
      throw new Error(`Missing event ${expected}; saw ${types.join(', ')}`)
    }
  }
  return types
}

async function main() {
  const client = await MongoClient.connect(config.mongoUrl)
  const db = client.db()
  let browser
  let user
  let originalHash
  let smokeHash
  let originalDoc
  let sessionId
  let releaseLock

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

    originalDoc = await readDocument()
    const originalContent = originalDoc.lines.join('\n')
    if (!originalContent.trim()) {
      throw new Error('Smoke document is empty; cannot prove replacement safely')
    }

    browser = await chromium.launch({ headless: !config.headed })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await login(page)
    const csrfToken = await getCsrfToken(page)
    sessionId = await createSession(page, csrfToken)

    const events = await sendLiveAutoAcceptEdit(
      page,
      csrfToken,
      sessionId,
      originalContent
    )
    const eventTypes = requireEventTypes(events, [
      'tool_call',
      'draft_change.created',
      'canonical_change.applying',
      'canonical_change.applied',
      'draft_change.accepted',
      'tool_result',
    ])

    const editToolCalls = events.filter(
      event => event.type === 'tool_call' && event.toolCall?.function?.name === 'edit_document'
    )
    if (editToolCalls.length !== 1) {
      throw new Error(`Expected one edit_document call, got ${editToolCalls.length}`)
    }
    const forbiddenTool = events.find(
      event =>
        event.type === 'tool_call' &&
        FORBIDDEN_TOOL_NAMES.has(event.toolCall?.function?.name)
    )
    if (forbiddenTool) {
      throw new Error(`Unexpected forbidden tool call: ${forbiddenTool.toolCall.function.name}`)
    }

    const acceptedEvent = events.find(event => event.type === 'draft_change.accepted')
    if (acceptedEvent?.draftChange?.status !== 'accepted') {
      throw new Error(`Accepted event did not include accepted draft: ${JSON.stringify(acceptedEvent)}`)
    }

    const changedDoc = await readDocument()
    const changedContent = changedDoc.lines.join('\n')
    if (!changedContent.includes(RUN_MARKER)) {
      throw new Error(`Document was not updated with live marker: ${changedContent}`)
    }
    if (!(changedDoc.version > originalDoc.version)) {
      throw new Error(
        `Document version did not advance: before=${originalDoc.version}, after=${changedDoc.version}`
      )
    }

    const sessionObjectId = new ObjectId(sessionId)
    const draft = await (await collection(db, 'aiAgentDraftChanges')).findOne({
      sessionId: sessionObjectId,
      status: 'accepted',
    })
    if (!draft) throw new Error('Accepted draft change was not persisted')
    const applyOperation = await (await collection(db, 'aiAgentApplyOperations')).findOne({
      sessionId: sessionObjectId,
      status: 'succeeded',
    })
    if (!applyOperation) throw new Error('Succeeded apply operation was not persisted')

    await browser.close()
    browser = null

    await restoreDocument(originalDoc, user._id.toString())
    const restoredDoc = await readDocument()
    const restoredContent = restoredDoc.lines.join('\n')
    if (restoredContent !== originalContent) {
      throw new Error('Document restore did not return the original content')
    }

    await cleanupSessionRecords(db, sessionId)
    const cleanupCounts = await assertNoSessionResidue(db, sessionId)
    await restorePassword(db, user, originalHash, smokeHash)
    originalHash = null
    smokeHash = null

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      sessionId,
      modelPath: 'web-proxy -> ai-writing-agent -> live model -> edit_document -> canonical writeback',
      eventTypes,
      beforeVersion: originalDoc.version,
      changedVersion: changedDoc.version,
      restoredVersion: restoredDoc.version,
      acceptedChangeId: draft._id.toString(),
      applyOperationId: applyOperation._id.toString(),
      cleanupCounts,
    }, null, 2))
  } catch (error) {
    if (browser) await browser.close().catch(() => {})
    if (originalDoc) {
      try {
        const current = await readDocument()
        const currentContent = current.lines.join('\n')
        const originalContent = originalDoc.lines.join('\n')
        if (currentContent !== originalContent) {
          await restoreDocument(originalDoc, user?._id?.toString?.() || '')
        }
      } catch (restoreError) {
        console.error(`WARN: failed to restore smoke document: ${restoreError.message}`)
      }
    }
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
