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

const RUN_MARKER = `agent-team-child-writeback-smoke-${Date.now()}`
const SMOKE_USER_LOCK_ID = 'agent-smoke-user-password'
const SMOKE_USER_LOCK_TTL_MS = 10 * 60_000
const FORBIDDEN_CHILD_TOOL_NAMES = new Set([
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
  if (!sessionId) return null
  const scope = await collectCleanupScope(db, sessionId)
  const { objectId, sessionIds, teamIds, changeSetIds } = scope
  await Promise.all([
    (await collection(db, 'aiSessions')).deleteMany({ _id: { $in: sessionIds } }),
    (await collection(db, 'aiMessages')).deleteMany({ sessionId: { $in: sessionIds } }),
    (await collection(db, 'aiAgentChangeSets')).deleteMany({ sessionId: objectId }),
    (await collection(db, 'aiAgentDraftChanges')).deleteMany({ sessionId: objectId }),
    (await collection(db, 'aiAgentApplyOperations')).deleteMany({ sessionId: objectId }),
    (await collection(db, 'aiAgentTasks')).deleteMany({ rootSessionId: objectId }),
    (await collection(db, 'aiAgentTeams')).deleteMany({ rootSessionId: objectId }),
    (await collection(db, 'aiAgentTeamEvents')).deleteMany({
      $or: [{ sessionId: { $in: sessionIds } }, { teamId: { $in: teamIds } }],
    }),
    (await collection(db, 'aiAgentTaskResults')).deleteMany({ teamId: { $in: teamIds } }),
    (await collection(db, 'aiAgentContextPacks')).deleteMany({ teamId: { $in: teamIds } }),
    changeSetIds.length
      ? (await collection(db, 'aiAgentApplyOperations')).deleteMany({
          changeSetId: { $in: changeSetIds },
        })
      : Promise.resolve(),
  ])
  return scope
}

async function collectCleanupScope(db, sessionId) {
  const objectId = new ObjectId(sessionId)
  const sessionIds = [
    objectId,
    ...(await (await collection(db, 'aiSessions'))
      .find({ rootSessionId: objectId }, { projection: { _id: 1 } })
      .toArray()).map(session => session._id),
  ]
  const changeSets = await (await collection(db, 'aiAgentChangeSets'))
    .find({ sessionId: objectId })
    .toArray()
  const changeSetIds = changeSets.map(changeSet => changeSet._id)
  const teams = await (await collection(db, 'aiAgentTeams'))
    .find({ rootSessionId: objectId }, { projection: { _id: 1 } })
    .toArray()
  const teamIds = teams.map(team => team._id)
  return { objectId, sessionIds, teamIds, changeSetIds }
}

async function assertNoSessionResidue(db, sessionId, cleanupScope = null) {
  const scope = cleanupScope || await collectCleanupScope(db, sessionId)
  const { objectId, sessionIds, teamIds, changeSetIds } = scope
  const checks = {
    aiSessions: await (await collection(db, 'aiSessions')).countDocuments({
      $or: [{ _id: objectId }, { rootSessionId: objectId }],
    }),
    aiMessages: await (await collection(db, 'aiMessages')).countDocuments({
      sessionId: { $in: sessionIds },
    }),
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
      $or: [{ sessionId: { $in: sessionIds } }, { teamId: { $in: teamIds } }],
    }),
    aiAgentTaskResults: await (await collection(db, 'aiAgentTaskResults')).countDocuments({
      teamId: { $in: teamIds },
    }),
    aiAgentContextPacks: await (await collection(db, 'aiAgentContextPacks')).countDocuments({
      teamId: { $in: teamIds },
    }),
    aiAgentApplyOperationsByChangeSet: changeSetIds.length
      ? await (await collection(db, 'aiAgentApplyOperations')).countDocuments({
          changeSetId: { $in: changeSetIds },
        })
      : 0,
  }
  const residue = Object.entries(checks).filter(([, count]) => count !== 0)
  if (residue.length) {
    throw new Error(`Child writeback smoke cleanup left residue: ${JSON.stringify(checks)}`)
  }
  return checks
}

async function sendLiveChildAutoAcceptEdit(page, csrfToken, sessionId, originalContent) {
  const replacement = `${RUN_MARKER}\n`
  const taskSpec = {
    capabilityName: 'writing-editor',
    mode: 'tool',
    objective: `Read ${config.docPath}, then call edit_document exactly once to replace the entire current document text ${JSON.stringify(originalContent)} with exactly ${JSON.stringify(replacement)}. Return done after the edit tool result.`,
    acceptanceCriteria: [
      'The child agent calls read_document before editing.',
      'The child agent calls edit_document exactly once.',
      'The document contains the requested marker after Auto Accept writeback.',
    ],
    input: { userRequest: `Replace ${config.docPath} with ${replacement}` },
    outputSchema: { type: 'object' },
    policy: {
      tools: ['read_document', 'edit_document'],
      fileGlobs: ['**/*.tex'],
      writeGlobs: ['**/*.tex'],
      maxToolCalls: 4,
    },
    timeoutMs: 120000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
  }
  const prompt = [
    'Call start_agent_task exactly once with this JSON task spec:',
    JSON.stringify(taskSpec),
    'Do not edit the document yourself in the root agent.',
    'After start_agent_task returns, answer with exactly done.',
  ].join(' ')

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
  const body = await response.text()
  if (response.status() !== 200) {
    throw new Error(`Send message failed ${response.status()}: ${body}`)
  }
  return parseSSE(body)
}

function requireEventTypes(events, expectedTypes) {
  const types = events.map(event => event.type)
  for (const expected of expectedTypes) {
    if (!types.includes(expected)) {
      const toolSummary = events
        .filter(event => event.type === 'tool_call' || event.type === 'tool_result')
        .map(event => ({
          type: event.type,
          toolName: event.toolCall?.function?.name || event.toolName,
          result: event.result?.output?.slice?.(0, 500) || event.result?.error || null,
        }))
      throw new Error(
        `Missing event ${expected}; saw ${types.join(', ')}; tools=${JSON.stringify(toolSummary)}`
      )
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

    const events = await sendLiveChildAutoAcceptEdit(
      page,
      csrfToken,
      sessionId,
      originalContent
    )
    const eventTypes = requireEventTypes(events, [
      'tool_call',
      'agent_team.started',
      'tool_result',
      'message_complete',
    ])

    const startTaskCalls = events.filter(
      event => event.type === 'tool_call' && event.toolCall?.function?.name === 'start_agent_task'
    )
    if (startTaskCalls.length !== 1) {
      throw new Error(`Expected one start_agent_task call, got ${startTaskCalls.length}`)
    }
    const rootEditCalls = events.filter(
      event => event.type === 'tool_call' && event.toolCall?.function?.name === 'edit_document'
    )
    if (rootEditCalls.length !== 0) {
      throw new Error(`Root agent unexpectedly called edit_document ${rootEditCalls.length} time(s)`)
    }
    const forbiddenTool = events.find(
      event =>
        event.type === 'tool_call' &&
        FORBIDDEN_CHILD_TOOL_NAMES.has(event.toolCall?.function?.name)
    )
    if (forbiddenTool) {
      throw new Error(`Unexpected forbidden tool call: ${forbiddenTool.toolCall.function.name}`)
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
    if (!draft.childSessionId || !draft.parentSessionId) {
      throw new Error(`Accepted draft did not include child provenance: ${JSON.stringify(draft.provenance || {})}`)
    }
    if (draft.provenance?.capabilityName !== 'writing-editor' || !draft.provenance?.teamId || !draft.provenance?.taskId) {
      throw new Error(`Accepted draft missing team provenance: ${JSON.stringify(draft.provenance || {})}`)
    }
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

    const cleanupScope = await cleanupSessionRecords(db, sessionId)
    const cleanupCounts = await assertNoSessionResidue(db, sessionId, cleanupScope)
    await restorePassword(db, user, originalHash, smokeHash)
    originalHash = null
    smokeHash = null

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      sessionId,
      modelPath: 'web-proxy -> root live model -> start_agent_task -> child live model -> edit_document -> canonical writeback',
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
