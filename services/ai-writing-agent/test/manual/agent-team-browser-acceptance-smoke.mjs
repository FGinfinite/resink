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
const DEFAULT_SCREENSHOT = '/tmp/agent-team-browser-acceptance-smoke.png'

const RUN_MARKER = `agent-team-browser-acceptance-smoke-${Date.now()}`
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
  screenshotPath: getArg('screenshot', DEFAULT_SCREENSHOT),
  headed: process.argv.includes('--headed'),
}

function atOffset(ms) {
  return new Date(Date.now() + ms)
}

function oid() {
  return new ObjectId()
}

function createSmokeIds() {
  return {
    session: oid(),
    runningTeam: oid(),
    retryTeam: oid(),
    contentTask: oid(),
    experimentTask: oid(),
    reducerTask: oid(),
    handoffTask: oid(),
    failedTask: oid(),
    policyTask: oid(),
    contentChildSession: oid(),
    experimentChildSession: oid(),
    handoffChildSession: oid(),
    contentResult: oid(),
    failedResult: oid(),
    policyResult: oid(),
    changeSet: oid(),
    draftChange: oid(),
  }
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

async function seedSmokeState(db, user, ids) {
  const userId = user._id.toString()
  const projectId = config.projectId.toString()
  const now = new Date()

  await (await collection(db, 'aiSessions')).insertMany([
    {
      _id: ids.session,
      projectId,
      userId,
      title: 'Agent Team Browser Acceptance Smoke',
      status: 'active',
      runtimeMode: 'agent-loop-v2',
      profile: 'default',
      messages: [],
      pendingChanges: [],
      activeHandoff: {
        teamId: ids.runningTeam.toString(),
        taskId: ids.handoffTask.toString(),
        childSessionId: ids.handoffChildSession.toString(),
        capabilityName: 'compile-fixer',
        objective: 'Fix the smoke LaTeX compile error in a specialist handoff.',
        startedAt: now,
      },
      createdAt: now,
      updatedAt: now,
      lastTurnAt: now,
      expiresAt: atOffset(60 * 60_000),
      smokeMarker: RUN_MARKER,
    },
    {
      _id: ids.contentChildSession,
      projectId,
      userId,
      parentId: ids.session,
      parentSessionId: ids.session,
      rootSessionId: ids.session,
      title: 'Smoke content reviewer child',
      status: 'active',
      runtimeMode: 'agent-loop-v2',
      activeTurn: { status: 'running', startedAt: now },
      createdAt: now,
      updatedAt: now,
      smokeMarker: RUN_MARKER,
    },
    {
      _id: ids.experimentChildSession,
      projectId,
      userId,
      parentId: ids.session,
      parentSessionId: ids.session,
      rootSessionId: ids.session,
      title: 'Smoke experiment reviewer child',
      status: 'active',
      runtimeMode: 'agent-loop-v2',
      activeTurn: { status: 'running', startedAt: now },
      createdAt: now,
      updatedAt: now,
      smokeMarker: RUN_MARKER,
    },
    {
      _id: ids.handoffChildSession,
      projectId,
      userId,
      parentId: ids.session,
      parentSessionId: ids.session,
      rootSessionId: ids.session,
      title: 'Smoke compile fixer child',
      status: 'active',
      runtimeMode: 'agent-loop-v2',
      activeTurn: { status: 'running', startedAt: now },
      createdAt: now,
      updatedAt: now,
      smokeMarker: RUN_MARKER,
    },
  ])

  await (await collection(db, 'aiAgentTeams')).insertMany([
    {
      _id: ids.runningTeam,
      projectId,
      userId,
      rootSessionId: ids.session,
      rootChangeSetId: ids.changeSet,
      workflowType: 'deep-review',
      status: 'running',
      mode: 'workflow-graph',
      startedBy: 'model',
      policySummary: { tools: ['read_document'], escalation: 'deny_by_default' },
      budgetSummary: { timeoutMs: 120000, maxParallelTasks: 3 },
      startedAt: atOffset(-45_000),
      updatedAt: now,
      completedAt: null,
      smokeMarker: RUN_MARKER,
    },
    {
      _id: ids.retryTeam,
      projectId,
      userId,
      rootSessionId: ids.session,
      rootChangeSetId: ids.changeSet,
      workflowType: 'skill-capability',
      status: 'failed',
      mode: 'subagent-tool',
      startedBy: 'model',
      policySummary: { capability: 'skill:latex-style-checker' },
      budgetSummary: { timeoutMs: 60000, maxParallelTasks: 1 },
      archiveReason: 'policy-denied',
      startedAt: atOffset(-90_000),
      updatedAt: atOffset(-10_000),
      completedAt: atOffset(-10_000),
      smokeMarker: RUN_MARKER,
    },
  ])

  const taskBase = {
    parentTaskId: null,
    rootSessionId: ids.session,
    toolCallId: null,
    agentVersion: '1.0.0',
    acceptanceCriteria: ['Smoke acceptance evidence is visible in browser UI'],
    input: {},
    outputSchema: { type: 'object' },
    contextPackId: null,
    dependencies: [],
    priority: 0,
    timeoutMs: 120000,
    retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    error: null,
    createdAt: atOffset(-50_000),
    updatedAt: now,
    smokeMarker: RUN_MARKER,
  }

  await (await collection(db, 'aiAgentTasks')).insertMany([
    {
      ...taskBase,
      _id: ids.contentTask,
      teamId: ids.runningTeam,
      childSessionId: ids.contentChildSession,
      agentName: 'content-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review claims and generate one smoke draft.',
      policy: { tools: ['read_document', 'edit_document'], writeMode: 'review' },
      resultId: ids.contentResult,
      startedAt: atOffset(-40_000),
      completedAt: null,
    },
    {
      ...taskBase,
      _id: ids.experimentTask,
      teamId: ids.runningTeam,
      childSessionId: ids.experimentChildSession,
      agentName: 'experiment-reviewer',
      mode: 'workflow-node',
      status: 'running',
      objective: 'Review experimental evidence in parallel.',
      policy: { tools: ['read_document'] },
      resultId: null,
      startedAt: atOffset(-35_000),
      completedAt: null,
    },
    {
      ...taskBase,
      _id: ids.reducerTask,
      teamId: ids.runningTeam,
      childSessionId: null,
      agentName: 'deep-review-reducer',
      mode: 'reducer',
      status: 'queued',
      objective: 'Join reviewer outputs after fan-out completes.',
      policy: { tools: ['read_document'] },
      dependencies: [ids.contentTask, ids.experimentTask],
      resultId: null,
      startedAt: null,
      completedAt: null,
    },
    {
      ...taskBase,
      _id: ids.handoffTask,
      teamId: ids.runningTeam,
      childSessionId: ids.handoffChildSession,
      agentName: 'compile-fixer',
      mode: 'handoff',
      status: 'running',
      objective: 'Fix a LaTeX compile error through handoff.',
      policy: { tools: ['read_document', 'edit_document'], handoff: true },
      resultId: null,
      startedAt: atOffset(-20_000),
      completedAt: null,
    },
    {
      ...taskBase,
      _id: ids.failedTask,
      teamId: ids.retryTeam,
      childSessionId: null,
      agentName: 'skill:latex-style-checker',
      mode: 'tool',
      status: 'failed',
      objective: 'Run a skill-provided style checker capability.',
      policy: { capabilitySource: 'skill', tools: ['read_document'] },
      resultId: ids.failedResult,
      error: { reason: 'transient-style-checker-failure' },
      startedAt: atOffset(-85_000),
      completedAt: atOffset(-70_000),
    },
    {
      ...taskBase,
      _id: ids.policyTask,
      teamId: ids.retryTeam,
      childSessionId: null,
      agentName: 'terminal-policy-checker',
      mode: 'tool',
      status: 'failed',
      objective: 'Verify host command escalation is denied.',
      policy: { requestedTools: ['run_command'], terminal: 'denied' },
      resultId: ids.policyResult,
      error: { reason: 'policy-denied' },
      startedAt: atOffset(-65_000),
      completedAt: atOffset(-60_000),
    },
  ])

  await (await collection(db, 'aiAgentTaskResults')).insertMany([
    {
      _id: ids.contentResult,
      taskId: ids.contentTask,
      teamId: ids.runningTeam,
      status: 'completed',
      summary: 'Smoke content reviewer found one issue and produced a review draft.',
      findings: [{ severity: 'minor', title: 'Clarify theorem statement' }],
      proposedEdits: [],
      artifacts: [{ type: 'note', title: 'Content smoke artifact' }],
      evidenceRefs: [],
      unresolvedQuestions: [],
      confidence: 0.9,
      nextActions: [],
      usage: { tokens: 42 },
      createdAt: atOffset(-30_000),
      smokeMarker: RUN_MARKER,
    },
    {
      _id: ids.failedResult,
      taskId: ids.failedTask,
      teamId: ids.retryTeam,
      status: 'failed',
      summary: 'Skill capability failed before retry.',
      findings: [],
      proposedEdits: [],
      artifacts: [],
      evidenceRefs: [],
      unresolvedQuestions: ['Retry should be queued through the web path.'],
      confidence: 0.1,
      nextActions: [],
      usage: { tokens: 12 },
      createdAt: atOffset(-70_000),
      smokeMarker: RUN_MARKER,
    },
    {
      _id: ids.policyResult,
      taskId: ids.policyTask,
      teamId: ids.retryTeam,
      status: 'failed',
      summary: 'Policy denied unsafe terminal escalation.',
      findings: [{ severity: 'high', title: 'Host command blocked' }],
      proposedEdits: [],
      artifacts: [],
      evidenceRefs: [],
      unresolvedQuestions: [],
      confidence: 1,
      nextActions: [],
      usage: { tokens: 4 },
      createdAt: atOffset(-60_000),
      smokeMarker: RUN_MARKER,
    },
  ])

  await (await collection(db, 'aiAgentChangeSets')).insertOne({
    _id: ids.changeSet,
    sessionId: ids.session,
    projectId,
    userId,
    turnId: 'smoke-turn',
    status: 'review',
    mode: 'review',
    createdAt: atOffset(-42_000),
    updatedAt: atOffset(-10_000),
    closedAt: null,
    summary: 'Smoke child draft with conflict state.',
    changeIds: [ids.draftChange],
    smokeMarker: RUN_MARKER,
  })

  await (await collection(db, 'aiAgentDraftChanges')).insertOne({
    _id: ids.draftChange,
    changeSetId: ids.changeSet,
    sessionId: ids.session,
    turnId: 'smoke-turn',
    toolCallId: 'smoke-tool-call',
    parentSessionId: ids.session,
    childSessionId: ids.contentChildSession,
    projectId,
    userId,
    type: 'edit',
    source: 'agent-loop-v2',
    path: '/main.tex',
    docId: null,
    entityId: null,
    baseVersion: 1,
    position: { start: 0, end: 0 },
    oldText: 'Old smoke text',
    newText: 'New smoke text',
    status: 'conflict',
    createdAt: atOffset(-35_000),
    updatedAt: atOffset(-15_000),
    appliedAt: null,
    rejectedAt: null,
    conflictAt: atOffset(-15_000),
    conflictType: 'VERSION_MISMATCH',
    conflictMessage: 'Smoke stale draft conflict',
    appliedVersion: null,
    wasRebased: false,
    provenance: {
      agentName: 'content-reviewer',
      teamId: ids.runningTeam.toString(),
      taskId: ids.contentTask.toString(),
      capabilityName: 'deep-review',
    },
    smokeMarker: RUN_MARKER,
  })

  const eventDocs = [
    {
      teamId: ids.runningTeam,
      taskId: null,
      type: 'agent_team.started',
      payload: { workflowType: 'deep-review', mode: 'workflow-graph' },
    },
    {
      teamId: ids.runningTeam,
      taskId: ids.contentTask,
      type: 'agent_graph.node_started',
      payload: { node: 'content-reviewer' },
    },
    {
      teamId: ids.runningTeam,
      taskId: ids.experimentTask,
      type: 'agent_graph.node_started',
      payload: { node: 'experiment-reviewer' },
    },
    {
      teamId: ids.runningTeam,
      taskId: ids.contentTask,
      type: 'draft_change.created',
      payload: {
        taskId: ids.contentTask.toString(),
        draftChangeId: ids.draftChange.toString(),
      },
    },
    {
      teamId: ids.runningTeam,
      taskId: ids.contentTask,
      type: 'draft_change.conflict',
      payload: {
        taskId: ids.contentTask.toString(),
        draftChangeId: ids.draftChange.toString(),
        conflictType: 'VERSION_MISMATCH',
      },
    },
    {
      teamId: ids.runningTeam,
      taskId: ids.handoffTask,
      type: 'agent_handoff.accepted',
      payload: {
        capabilityName: 'compile-fixer',
        childSessionId: ids.handoffChildSession.toString(),
      },
    },
    {
      teamId: ids.retryTeam,
      taskId: ids.failedTask,
      type: 'agent_skill.capability_loaded',
      payload: { capabilityName: 'skill:latex-style-checker' },
    },
    {
      teamId: ids.retryTeam,
      taskId: ids.policyTask,
      type: 'agent_policy.denied',
      payload: { tool: 'run_command', reason: 'host-shell-denied' },
    },
  ].map(event => ({
    _id: oid(),
    sessionId: ids.session,
    createdAt: now,
    smokeMarker: RUN_MARKER,
    ...event,
  }))

  await (await collection(db, 'aiAgentTeamEvents')).insertMany(eventDocs)

  return ids
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

async function cleanupSmokeState(db, user, originalHash, smokeHash, ids) {
  await restorePassword(db, user, originalHash, smokeHash)

  const sessionIds = ids
    ? [
        ids.session,
        ids.contentChildSession,
        ids.experimentChildSession,
        ids.handoffChildSession,
      ]
    : []
  const teamIds = ids ? [ids.runningTeam, ids.retryTeam] : []

  await Promise.all([
    (await collection(db, 'aiSessions')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { _id: { $in: sessionIds } }],
    }),
    (await collection(db, 'aiAgentTeams')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { _id: { $in: teamIds } }],
    }),
    (await collection(db, 'aiAgentTasks')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    (await collection(db, 'aiAgentTaskResults')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    (await collection(db, 'aiAgentTeamEvents')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    (await collection(db, 'aiAgentContextPacks')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    (await collection(db, 'aiAgentChangeSets')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { sessionId: { $in: sessionIds } }],
    }),
    (await collection(db, 'aiAgentDraftChanges')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { sessionId: { $in: sessionIds } }],
    }),
    (await collection(db, 'aiAgentApplyOperations')).deleteMany({
      $or: [{ smokeMarker: RUN_MARKER }, { sessionId: { $in: sessionIds } }],
    }),
  ])
}

async function assertNoSmokeResidue(db, ids) {
  const sessionIds = [
    ids.session,
    ids.contentChildSession,
    ids.experimentChildSession,
    ids.handoffChildSession,
  ]
  const teamIds = [ids.runningTeam, ids.retryTeam]
  const checks = {
    aiSessions: await (await collection(db, 'aiSessions')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { _id: { $in: sessionIds } }],
    }),
    aiAgentTeams: await (await collection(db, 'aiAgentTeams')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { _id: { $in: teamIds } }],
    }),
    aiAgentTasks: await (await collection(db, 'aiAgentTasks')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    aiAgentDraftChanges: await (await collection(db, 'aiAgentDraftChanges')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { sessionId: { $in: sessionIds } }],
    }),
    aiAgentTaskResults: await (await collection(db, 'aiAgentTaskResults')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    aiAgentTeamEvents: await (await collection(db, 'aiAgentTeamEvents')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    aiAgentContextPacks: await (await collection(db, 'aiAgentContextPacks')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { teamId: { $in: teamIds } }],
    }),
    aiAgentChangeSets: await (await collection(db, 'aiAgentChangeSets')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { sessionId: { $in: sessionIds } }],
    }),
    aiAgentApplyOperations: await (await collection(db, 'aiAgentApplyOperations')).countDocuments({
      $or: [{ smokeMarker: RUN_MARKER }, { sessionId: { $in: sessionIds } }],
    }),
  }
  const residue = Object.entries(checks).filter(([, count]) => count !== 0)
  if (residue.length) {
    throw new Error(`Smoke cleanup left residue: ${JSON.stringify(checks)}`)
  }
  return checks
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

async function openAssistant(page, sessionId) {
  await page.goto(
    `${config.baseUrl}/project/${config.projectId.toString()}?aiSession=${sessionId.toString()}`,
    { waitUntil: 'domcontentloaded' }
  )
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
  const aiButton = page
    .locator('button.toolbar-ai-status[aria-label="AI Assistant"], [aria-label="AI Assistant"]')
    .first()
  await aiButton.waitFor({ timeout: 20000 })
  await aiButton.click()
  await page.waitForSelector('.ai-team-trace-block', { timeout: 30000 })
}

async function clickTraceHeader(trace) {
  await trace.locator('.ai-tool-call-header-clickable').first().click()
}

async function waitForTeamStatus(db, teamId, status) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const team = await (await collection(db, 'aiAgentTeams')).findOne({ _id: teamId })
    if (team?.status === status) return team
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Team ${teamId.toString()} did not reach status ${status}`)
}

async function waitForRetryTask(db, sourceTaskId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const retryTask = await (await collection(db, 'aiAgentTasks')).findOne({
      parentTaskId: sourceTaskId,
      status: 'queued',
    })
    if (retryTask) return retryTask
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Retry task was not queued for ${sourceTaskId.toString()}`)
}

async function main() {
  const client = await MongoClient.connect(config.mongoUrl)
  const db = client.db()
  let browser
  let ids
  let originalHash
  let smokeHash
  let releaseLock

  try {
    releaseLock = await acquireSmokeUserLock(db)
    const user = await (await collection(db, 'users')).findOne({ email: config.email })
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

    ids = createSmokeIds()
    await seedSmokeState(db, user, ids)

    browser = await chromium.launch({ headless: !config.headed })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', error => console.log(`pageerror:${error.message}`))

    await login(page)
    await openAssistant(page, ids.session)

    const handoffBanner = page.locator('.ai-active-handoff-banner')
    await handoffBanner.waitFor({ timeout: 15000 })
    const handoffText = await handoffBanner.innerText()
    if (!handoffText.includes('compile-fixer')) {
      throw new Error(`Active handoff banner did not show compile-fixer: ${handoffText}`)
    }

    const deepReviewTrace = page
      .locator('.ai-team-trace-block')
      .filter({ hasText: 'Team deep-review' })
      .first()
    const skillTrace = page
      .locator('.ai-team-trace-block')
      .filter({ hasText: 'Team skill-capability' })
      .first()
    await deepReviewTrace.waitFor({ timeout: 15000 })
    await skillTrace.waitFor({ timeout: 15000 })

    const deepReviewText = await deepReviewTrace.innerText()
    if (!deepReviewText.includes('1 findings') || !deepReviewText.includes('1 artifacts') || !deepReviewText.includes('1 drafts')) {
      throw new Error(`Deep Review trace metrics were not rendered: ${deepReviewText}`)
    }

    await clickTraceHeader(deepReviewTrace)
    await clickTraceHeader(skillTrace)

    const expandedText = await page.locator('.ai-team-trace-block').evaluateAll(nodes =>
      nodes.map(node => node.textContent || '').join('\n')
    )
    for (const expected of [
      'content-reviewer',
      'experiment-reviewer',
      'deep-review-reducer',
      'compile-fixer',
      'skill:latex-style-checker',
      'terminal-policy-checker',
      'Queue retry',
      'draft_change.conflict',
      'agent_policy.denied',
      'agent_skill.capability_loaded',
    ]) {
      if (!expandedText.includes(expected)) {
        throw new Error(`Expanded Team Trace missing ${expected}: ${expandedText}`)
      }
    }

    await skillTrace.locator('.ai-team-task-retry').first().click()
    const retryTask = await waitForRetryTask(db, ids.failedTask)
    const retryTeam = await waitForTeamStatus(db, ids.retryTeam, 'running')
    if (retryTeam.completedAt !== null) {
      throw new Error('Retry did not clear completedAt on the team run')
    }

    await deepReviewTrace.getByRole('button', { name: /Cancel team/i }).click()
    await waitForTeamStatus(db, ids.runningTeam, 'cancelled')
    const activeTaskCount = await (await collection(db, 'aiAgentTasks')).countDocuments({
      teamId: ids.runningTeam,
      status: { $in: ['queued', 'running'] },
    })
    if (activeTaskCount !== 0) {
      throw new Error(`Cancel left ${activeTaskCount} queued/running tasks`)
    }
    const refreshedSession = await (await collection(db, 'aiSessions')).findOne({ _id: ids.session })
    if (refreshedSession?.activeHandoff) {
      throw new Error('Cancel did not clear activeHandoff from root session')
    }

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
    await page.waitForSelector('.ai-team-trace-block', { timeout: 30000 })
    const reloadedText = await page.locator('.ai-team-trace-block').evaluateAll(nodes =>
      nodes.map(node => node.textContent || '').join('\n')
    )
    for (const expected of ['Team deep-review · cancelled', 'Team skill-capability · running']) {
      if (!reloadedText.includes(expected)) {
        throw new Error(`Reloaded Team Trace missing ${expected}: ${reloadedText}`)
      }
    }

    await page.screenshot({ path: config.screenshotPath, fullPage: true })

    const verification = {
      retryTaskId: retryTask._id.toString(),
      runningTeamStatus: 'cancelled',
      retryTeamStatus: 'running',
      screenshotPath: config.screenshotPath,
      sessionId: ids.session.toString(),
      runningTeamId: ids.runningTeam.toString(),
      retryTeamId: ids.retryTeam.toString(),
    }

    await browser.close()
    browser = null
    await cleanupSmokeState(db, user, originalHash, smokeHash, ids)
    originalHash = null
    smokeHash = null
    const cleanupCounts = await assertNoSmokeResidue(db, ids)

    console.log(JSON.stringify({ ok: true, marker: RUN_MARKER, verification, cleanupCounts }, null, 2))
  } catch (error) {
    if (browser) {
      const pages = browser.contexts().flatMap(context => context.pages())
      const page = pages[0]
      if (page) {
        await page.screenshot({
          path: '/tmp/agent-team-browser-acceptance-smoke-failure.png',
          fullPage: true,
        }).catch(() => {})
      }
      await browser.close().catch(() => {})
    }
    throw error
  } finally {
    const user = await (await collection(db, 'users')).findOne({ email: config.email })
    if (user) {
      await cleanupSmokeState(db, user, originalHash, smokeHash, ids)
    }
    await releaseLock?.()
    await client.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
