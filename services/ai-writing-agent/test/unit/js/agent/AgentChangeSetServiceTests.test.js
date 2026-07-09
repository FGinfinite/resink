import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObjectId } from 'mongodb'

const changeSets = []
const draftChanges = []
const applyOperations = []
const sessionUpdates = []

function matchesValue(actual, expected) {
  if (expected && typeof expected === 'object' && '$in' in expected) {
    return expected.$in.some(value => value.toString() === actual?.toString?.())
  }
  return actual?.toString?.() === expected?.toString?.() || actual === expected
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) =>
    matchesValue(doc[key], expected)
  )
}

function createCursor(items) {
  return {
    items: [...items],
    sort(sortSpec) {
      const [[field, direction]] = Object.entries(sortSpec)
      this.items.sort((a, b) => {
        const av = a[field]?.getTime?.() || a[field]
        const bv = b[field]?.getTime?.() || b[field]
        return direction < 0 ? bv - av : av - bv
      })
      return this
    },
    async toArray() {
      return this.items
    },
  }
}

const db = {
  aiAgentChangeSets: {
    insertOne: vi.fn(async doc => {
      changeSets.push(doc)
      return { insertedId: doc._id }
    }),
    findOne: vi.fn(async filter =>
      changeSets.find(changeSet => matches(changeSet, filter)) || null
    ),
    find: vi.fn(filter =>
      createCursor(changeSets.filter(changeSet => matches(changeSet, filter)))
    ),
    updateOne: vi.fn(async (filter, update) => {
      const doc = changeSets.find(changeSet => matches(changeSet, filter))
      if (!doc) return { matchedCount: 0, modifiedCount: 0 }
      Object.assign(doc, update.$set || {})
      if (update.$addToSet?.changeIds) {
        const id = update.$addToSet.changeIds
        if (!doc.changeIds.some(existing => existing.toString() === id.toString())) {
          doc.changeIds.push(id)
        }
      }
      return { matchedCount: 1, modifiedCount: 1 }
    }),
  },
  aiAgentDraftChanges: {
    insertOne: vi.fn(async doc => {
      draftChanges.push(doc)
      return { insertedId: doc._id }
    }),
    find: vi.fn(filter =>
      createCursor(draftChanges.filter(change => matches(change, filter)))
    ),
    findOneAndUpdate: vi.fn(async (filter, update) => {
      const doc = draftChanges.find(change => matches(change, filter))
      if (!doc) return null
      Object.assign(doc, update.$set || {})
      return doc
    }),
  },
  aiAgentApplyOperations: {
    insertOne: vi.fn(async doc => {
      applyOperations.push(doc)
      return { insertedId: doc._id }
    }),
  },
  aiSessions: {
    updateOne: vi.fn(async (...args) => {
      sessionUpdates.push(args)
      return { matchedCount: 1, modifiedCount: 1 }
    }),
  },
}

const {
  AgentChangeSetService,
  serializeChangeSet,
  serializeDraftChange,
} = await import('../../../../app/js/agent/AgentChangeSetService.js')

describe('AgentChangeSetService', () => {
  let service
  let sessionId
  const projectId = 'project-1'
  const userId = 'user-1'
  const fixedNow = new Date('2026-06-21T00:00:00.000Z')

  beforeEach(() => {
    changeSets.length = 0
    draftChanges.length = 0
    applyOperations.length = 0
    sessionUpdates.length = 0
    for (const collection of Object.values(db)) {
      for (const method of Object.values(collection)) {
        if (method?.mockClear) method.mockClear()
      }
    }
    sessionId = new ObjectId()
    service = new AgentChangeSetService({
      db,
      now: () => new Date(fixedNow),
    })
  })

  it('creates authorized change sets and draft changes with safe provenance', async () => {
    const changeSet = await service.createChangeSet({
      sessionId,
      projectId,
      userId,
      turnId: 'turn-1',
      mode: 'review',
    })

    const change = await service.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      toolCallId: 'tool-1',
      type: 'edit',
      path: '/main.tex',
      docId: 'doc-1',
      baseVersion: 4,
      position: { start: 10, end: 14 },
      oldText: 'old',
      newText: 'new',
      provenance: {
        agentName: 'writer',
        toolName: 'edit_document',
        model: 'deepseek-v4-flash',
        teamId: 'team-1',
        taskId: 'task-1',
        capabilityName: 'writing-editor',
        hiddenPrompt: 'do not store',
      },
    })

    expect(changeSets[0].status).toBe('review')
    expect(changeSets[0].changeIds.map(id => id.toString())).toEqual([
      change._id.toString(),
    ])
    expect(change).toMatchObject({
      sessionId,
      projectId,
      userId,
      status: 'pending',
      source: 'agent-loop-v2',
      provenance: {
        agentName: 'writer',
        toolName: 'edit_document',
        model: 'deepseek-v4-flash',
        teamId: 'team-1',
        taskId: 'task-1',
        capabilityName: 'writing-editor',
      },
    })
    expect(change.provenance.hiddenPrompt).toBeUndefined()
  })

  it('lists change sets with draft changes only for the authorized session owner', async () => {
    const changeSet = await service.createChangeSet({ sessionId, projectId, userId })
    await service.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      type: 'create',
      path: '/new.tex',
      content: 'hello',
    })

    const authorized = await service.listChangeSets({ sessionId, projectId, userId })
    expect(authorized).toHaveLength(1)
    expect(authorized[0].draftChanges).toHaveLength(1)

    const wrongUser = await service.listChangeSets({
      sessionId,
      projectId,
      userId: 'other-user',
    })
    expect(wrongUser).toEqual([])
  })

  it('updates draft status and records apply operations', async () => {
    const changeSet = await service.createChangeSet({ sessionId, projectId, userId })
    const change = await service.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      path: '/main.tex',
      oldText: 'a',
      newText: 'b',
    })

    const updated = await service.updateDraftStatus({
      changeId: change._id,
      sessionId,
      projectId,
      userId,
      status: 'accepted',
      appliedVersion: 8,
      wasRebased: true,
    })
    await service.recordApplyOperation({
      changeId: change._id,
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      status: 'succeeded',
      finishedAt: new Date(fixedNow),
      appliedVersion: 8,
    })

    expect(updated).toMatchObject({
      status: 'accepted',
      appliedVersion: 8,
      wasRebased: true,
    })
    expect(updated.appliedAt).toEqual(fixedNow)
    expect(applyOperations[0]).toMatchObject({
      changeId: change._id,
      changeSetId: changeSet._id,
      status: 'succeeded',
      appliedVersion: 8,
    })
  })

  it('can mirror a draft change into legacy session pendingChanges temporarily', async () => {
    const changeSet = await service.createChangeSet({ sessionId, projectId, userId })
    const change = await service.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      path: '/main.tex',
      docId: 'doc-1',
      oldText: 'a',
      newText: 'b',
      mirrorToSessionPendingChanges: true,
    })

    expect(sessionUpdates).toHaveLength(1)
    expect(sessionUpdates[0][0]).toEqual({
      _id: sessionId,
      projectId,
      userId,
    })
    expect(sessionUpdates[0][1].$addToSet.pendingChanges).toMatchObject({
      id: change._id.toString(),
      changeSetId: changeSet._id.toString(),
      source: 'persistent-workspace',
      path: '/main.tex',
      status: 'pending',
    })
  })

  it('serializes change sets for browser restore', async () => {
    const changeSet = await service.createChangeSet({ sessionId, projectId, userId })
    const change = await service.createDraftChange({
      changeSetId: changeSet._id,
      sessionId,
      projectId,
      userId,
      path: '/main.tex',
      oldText: 'a',
      newText: 'b',
      provenance: { agentName: 'writer' },
    })

    const serialized = serializeChangeSet(changeSet, [change])
    expect(serialized).toMatchObject({
      id: changeSet._id.toString(),
      sessionId: sessionId.toString(),
      draftChanges: [
        {
          id: change._id.toString(),
          oldText: 'a',
          newText: 'b',
          provenance: { agentName: 'writer' },
        },
      ],
    })
    expect(serializeDraftChange(null)).toBeNull()
  })
})
