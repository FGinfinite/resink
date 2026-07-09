#!/usr/bin/env node

/* eslint-disable no-console */

import { MongoClient, ObjectId } from 'mongodb'
import { fileURLToPath } from 'node:url'

const DEFAULT_DOCUMENT_UPDATER_URL = 'http://127.0.0.1:3003'
const DEFAULT_MONGO_URL =
  'mongodb://127.0.0.1:37017/sharelatex?directConnection=true'
const DEFAULT_PROJECT_ID = '6a390bf87a13c32e536c279c'
const DEFAULT_DOC_ID = '6a390bf87a13c32e536c27a1'
const DEFAULT_DOC_PATH = '/main.tex'
const DEFAULT_USER_ID = '6a390bf87a13c32e536c279b'

const RUN_MARKER = `agent-team-writeback-conflict-smoke-${Date.now()}`
const SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function getArg(name, fallback) {
  const prefix = `--${name}=`
  const match = process.argv.find(arg => arg.startsWith(prefix))
  const envName = name.toUpperCase().replaceAll('-', '_')
  return match ? match.slice(prefix.length) : process.env[envName] || fallback
}

const config = {
  documentUpdaterUrl: getArg(
    'document-updater-url',
    DEFAULT_DOCUMENT_UPDATER_URL
  ).replace(/\/$/, ''),
  mongoUrl: getArg('mongo-url', DEFAULT_MONGO_URL),
  projectId: new ObjectId(getArg('project-id', DEFAULT_PROJECT_ID)),
  docId: new ObjectId(getArg('doc-id', DEFAULT_DOC_ID)),
  docPath: getArg('doc-path', DEFAULT_DOC_PATH),
  userId: getArg('user-id', DEFAULT_USER_ID),
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

async function setDocument(lines, expectedVersion, sourceKind) {
  const response = await fetch(
    `${config.documentUpdaterUrl}/project/${config.projectId.toString()}/doc/${config.docId.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lines,
        source: { kind: sourceKind },
        user_id: config.userId,
        expected_version: expectedVersion,
      }),
    }
  )
  if (!response.ok) {
    throw new Error(`Set document failed ${response.status}: ${await response.text()}`)
  }
}

async function createSmokeSession(db) {
  const now = new Date()
  const session = {
    _id: new ObjectId(),
    projectId: config.projectId,
    userId: config.userId,
    docId: config.docId,
    title: `Writeback conflict smoke ${RUN_MARKER}`,
    smokeMarker: RUN_MARKER,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    pendingChanges: [],
    changeHistory: [],
  }
  await db.collection('aiSessions').insertOne(session)
  return session
}

async function cleanupSmokeRecords(db, sessionId) {
  if (!sessionId) return
  const changeSets = await db.collection('aiAgentChangeSets')
    .find({ sessionId }, { projection: { _id: 1 } })
    .toArray()
  const changeSetIds = changeSets.map(changeSet => changeSet._id)
  const draftChanges = await db.collection('aiAgentDraftChanges')
    .find({ sessionId }, { projection: { _id: 1 } })
    .toArray()
  const draftChangeIds = draftChanges.map(change => change._id)
  await Promise.all([
    db.collection('aiSessions').deleteMany({ _id: sessionId }),
    db.collection('aiMessages').deleteMany({ sessionId }),
    db.collection('aiAgentChangeSets').deleteMany({ sessionId }),
    db.collection('aiAgentDraftChanges').deleteMany({ sessionId }),
    db.collection('aiAgentApplyOperations').deleteMany({
      $or: [
        { sessionId },
        { changeSetId: { $in: changeSetIds } },
        { changeId: { $in: draftChangeIds } },
      ],
    }),
  ])
}

async function assertNoSmokeResidue(db, sessionId) {
  const checks = {
    aiSessions: await db.collection('aiSessions').countDocuments({ _id: sessionId }),
    aiMessages: await db.collection('aiMessages').countDocuments({ sessionId }),
    aiAgentChangeSets: await db.collection('aiAgentChangeSets').countDocuments({ sessionId }),
    aiAgentDraftChanges: await db.collection('aiAgentDraftChanges').countDocuments({ sessionId }),
    aiAgentApplyOperations: await db.collection('aiAgentApplyOperations').countDocuments({ sessionId }),
  }
  const residue = Object.entries(checks).filter(([, count]) => count !== 0)
  if (residue.length) {
    throw new Error(`Writeback conflict smoke cleanup left residue: ${JSON.stringify(checks)}`)
  }
  return checks
}

function buildChangeSetDb(db) {
  return {
    aiSessions: db.collection('aiSessions'),
    aiAgentChangeSets: db.collection('aiAgentChangeSets'),
    aiAgentDraftChanges: db.collection('aiAgentDraftChanges'),
    aiAgentApplyOperations: db.collection('aiAgentApplyOperations'),
  }
}

async function main() {
  process.chdir(SERVICE_ROOT)
  const { DocumentAdapter } = await import('../../app/js/adapter/DocumentAdapter.js')
  const { AgentChangeSetService } = await import('../../app/js/agent/AgentChangeSetService.js')
  const { CanonicalWritebackService } = await import('../../app/js/agent/CanonicalWritebackService.js')

  const client = await MongoClient.connect(config.mongoUrl)
  const db = client.db()
  let originalDoc
  let advancedDoc
  let session

  try {
    originalDoc = await readDocument()
    const originalContent = originalDoc.lines.join('\n')
    if (!originalContent.trim()) {
      throw new Error('Smoke document is empty; cannot prove conflict safely')
    }

    session = await createSmokeSession(db)
    const changeSetService = new AgentChangeSetService({
      db: buildChangeSetDb(db),
    })
    const documentAdapter = new DocumentAdapter({
      documentUpdaterUrl: config.documentUpdaterUrl,
    })
    const writebackService = new CanonicalWritebackService({
      documentAdapter,
      changeSetService,
    })

    const changeSet = await changeSetService.createChangeSet({
      sessionId: session._id,
      projectId: config.projectId.toString(),
      userId: config.userId,
      turnId: `${RUN_MARKER}:turn`,
      mode: 'auto',
    })
    const draft = await changeSetService.createDraftChange({
      changeSetId: changeSet._id,
      sessionId: session._id,
      projectId: config.projectId.toString(),
      userId: config.userId,
      turnId: `${RUN_MARKER}:turn`,
      toolCallId: `${RUN_MARKER}:tool`,
      type: 'edit',
      source: 'agent-loop-v2',
      path: config.docPath,
      docId: config.docId.toString(),
      entityId: config.docId.toString(),
      baseVersion: originalDoc.version,
      oldText: originalContent,
      newText: `${RUN_MARKER}:ai-proposed\n`,
      newContent: `${RUN_MARKER}:ai-proposed\n`,
      position: { start: 0, end: originalContent.length },
      status: 'pending',
      provenance: {
        agentName: 'writeback-conflict-smoke',
        toolName: 'edit_document',
        model: 'manual-smoke',
        profile: 'manual-smoke',
        capabilityName: 'writing-editor',
      },
      mirrorToSessionPendingChanges: true,
    })

    await setDocument(
      [`${RUN_MARKER}:concurrent-user-edit`, ''],
      originalDoc.version,
      'ai-agent-writeback-conflict-smoke-concurrent-edit'
    )
    advancedDoc = await readDocument()
    if (!(advancedDoc.version > originalDoc.version)) {
      throw new Error(
        `Concurrent edit did not advance version: before=${originalDoc.version}, after=${advancedDoc.version}`
      )
    }

    const result = await writebackService.applyDraftChange({
      change: draft,
      userId: config.userId,
    })
    if (result.status !== 'conflict') {
      throw new Error(`Expected conflict result, got ${result.status}`)
    }
    const eventTypes = result.events.map(event => event.type)
    if (!eventTypes.includes('draft_change.conflict')) {
      throw new Error(`Expected draft_change.conflict event, got ${eventTypes.join(', ')}`)
    }
    const conflictType = result.events[0]?.conflictType
    if (!conflictType) {
      throw new Error('Conflict event did not include conflictType')
    }

    const persistedDraft = await db.collection('aiAgentDraftChanges').findOne({
      _id: draft._id,
    })
    if (persistedDraft?.status !== 'conflict') {
      throw new Error(`Draft status was not conflict: ${persistedDraft?.status}`)
    }
    if (persistedDraft.conflictType !== conflictType) {
      throw new Error(
        `Draft conflictType ${persistedDraft.conflictType} did not match event ${conflictType}`
      )
    }
    const applyOperation = await db.collection('aiAgentApplyOperations').findOne({
      changeId: draft._id,
      status: 'conflict',
    })
    if (!applyOperation) {
      throw new Error('Conflict apply operation was not persisted')
    }
    const afterConflictDoc = await readDocument()
    const afterConflictContent = afterConflictDoc.lines.join('\n')
    if (!afterConflictContent.includes(`${RUN_MARKER}:concurrent-user-edit`)) {
      throw new Error(`Conflict path overwrote concurrent edit: ${afterConflictContent}`)
    }
    if (afterConflictContent.includes(`${RUN_MARKER}:ai-proposed`)) {
      throw new Error(`Conflict path incorrectly applied AI proposal: ${afterConflictContent}`)
    }

    await setDocument(
      originalDoc.lines,
      afterConflictDoc.version,
      'ai-agent-writeback-conflict-smoke-restore'
    )
    const restoredDoc = await readDocument()
    const restoredContent = restoredDoc.lines.join('\n')
    if (restoredContent !== originalContent) {
      throw new Error('Document restore did not return the original content')
    }

    await cleanupSmokeRecords(db, session._id)
    const cleanupCounts = await assertNoSmokeResidue(db, session._id)

    console.log(JSON.stringify({
      ok: true,
      marker: RUN_MARKER,
      sessionId: session._id.toString(),
      changeSetId: changeSet._id.toString(),
      draftChangeId: draft._id.toString(),
      conflictType,
      beforeVersion: originalDoc.version,
      concurrentVersion: advancedDoc.version,
      restoredVersion: restoredDoc.version,
      applyOperationId: applyOperation._id.toString(),
      cleanupCounts,
    }, null, 2))
  } catch (error) {
    if (originalDoc) {
      try {
        const current = await readDocument()
        const currentContent = current.lines.join('\n')
        const originalContent = originalDoc.lines.join('\n')
        if (currentContent !== originalContent) {
          await setDocument(
            originalDoc.lines,
            current.version,
            'ai-agent-writeback-conflict-smoke-restore-after-error'
          )
        }
      } catch (restoreError) {
        console.error(`WARN: failed to restore smoke document: ${restoreError.message}`)
      }
    }
    throw error
  } finally {
    if (session?._id) {
      await cleanupSmokeRecords(db, session._id).catch(() => {})
    }
    await client.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
