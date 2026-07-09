import { beforeEach, describe, expect, it } from 'vitest'

const { ContextSnapshotService } = await import(
  '../../../../app/js/agent-context/ContextSnapshotService.js'
)

describe('ContextSnapshotService', () => {
  let snapshots
  let service

  beforeEach(() => {
    snapshots = []
    service = new ContextSnapshotService({
      snapshotsCollection: {
        async insertOne(doc) {
          snapshots.push({ _id: `snapshot-${snapshots.length + 1}`, ...doc })
          return { insertedId: snapshots.at(-1)._id }
        },
        async findOne(query) {
          return snapshots.find(snapshot => matches(snapshot, query)) || null
        },
      },
      now: () => new Date('2026-06-25T00:00:00.000Z'),
    })
  })

  it('stores source refs and totals without hidden prompt bodies', async () => {
    const snapshot = await service.createSnapshot({
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      turnId: 'turn-1',
      sourceRefs: [
        {
          type: 'memory',
          refId: 'memory-1',
          scope: 'project',
          tokenEstimate: 12,
          included: true,
          reason: 'scope match',
          content: 'must not persist',
        },
      ],
      hiddenPrompt: 'must not persist',
    })

    expect(snapshot).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      totals: {
        sourceCount: 1,
        tokenEstimate: 12,
        memoryCount: 1,
        recalledCount: 0,
      },
    })
    expect(JSON.stringify(snapshots[0])).not.toContain('must not persist')
    expect(snapshots[0].sourceRefs[0]).toEqual({
      type: 'memory',
      refId: 'memory-1',
      path: null,
      scope: 'project',
      tokenEstimate: 12,
      included: true,
      reason: 'scope match',
    })
  })

  it('finds snapshots only for the owning user and turn', async () => {
    snapshots.push(
      { sessionId: 'session-1', userId: 'user-2', turnId: 'turn-1' },
      { sessionId: 'session-1', userId: 'user-1', turnId: 'turn-2' },
      { sessionId: 'session-1', userId: 'user-1', turnId: 'turn-1', sourceRefs: [] }
    )

    const snapshot = await service.findSnapshot({
      sessionId: 'session-1',
      userId: 'user-1',
      turnId: 'turn-1',
    })

    expect(snapshot).toEqual({
      sessionId: 'session-1',
      userId: 'user-1',
      turnId: 'turn-1',
      sourceRefs: [],
    })
  })
})

function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => doc[key] === expected)
}
