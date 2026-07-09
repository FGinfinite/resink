import { beforeEach, describe, expect, it } from 'vitest'

const { SessionSummaryService } = await import(
  '../../../../app/js/agent-context/SessionSummaryService.js'
)

describe('SessionSummaryService', () => {
  let summaries
  let service

  beforeEach(() => {
    summaries = []
    service = new SessionSummaryService({
      summariesCollection: collection(summaries),
      now: () => new Date('2026-06-25T00:00:00.000Z'),
    })
  })

  it('creates active summaries for a session', async () => {
    const summary = await service.createSummary({
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      summary: 'Short session summary.',
      sourceMessageRange: { fromSeq: 1, toSeq: 4 },
      tokenEstimate: 32,
    })

    expect(summary).toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      summary: 'Short session summary.',
      status: 'active',
      tokenEstimate: 32,
    })
  })

  it('finds the latest active summary for the owning user', async () => {
    summaries.push(
      {
        sessionId: 'session-1',
        userId: 'user-2',
        status: 'active',
        summary: 'Other user',
        createdAt: new Date('2026-06-25T01:00:00.000Z'),
      },
      {
        sessionId: 'session-1',
        userId: 'user-1',
        status: 'superseded',
        summary: 'Superseded',
        createdAt: new Date('2026-06-25T02:00:00.000Z'),
      },
      {
        sessionId: 'session-1',
        userId: 'user-1',
        status: 'active',
        summary: 'Older',
        createdAt: new Date('2026-06-25T00:00:00.000Z'),
      },
      {
        sessionId: 'session-1',
        userId: 'user-1',
        status: 'active',
        summary: 'Latest',
        createdAt: new Date('2026-06-25T03:00:00.000Z'),
      }
    )

    const summary = await service.findLatestSummary({
      sessionId: 'session-1',
      userId: 'user-1',
    })

    expect(summary.summary).toBe('Latest')
  })

  it('supersedes existing active summaries before creating a new active summary', async () => {
    summaries.push({
      _id: 'old-summary',
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      status: 'active',
      summary: 'Older',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      updatedAt: new Date('2026-06-24T00:00:00.000Z'),
      supersededAt: null,
    })

    await service.createSummary({
      sessionId: 'session-1',
      projectId: 'project-1',
      userId: 'user-1',
      summary: 'New summary.',
    })

    expect(summaries[0]).toMatchObject({
      status: 'superseded',
      supersededAt: new Date('2026-06-25T00:00:00.000Z'),
    })
    expect(summaries[1]).toMatchObject({
      status: 'active',
      summary: 'New summary.',
    })
  })
})

function collection(items) {
  return {
    async insertOne(doc) {
      items.push({ _id: `summary-${items.length + 1}`, ...doc })
      return { insertedId: items.at(-1)._id }
    },
    async updateMany(query, update) {
      let modifiedCount = 0
      for (const item of items) {
        if (!matches(item, query)) continue
        if (update.$set) Object.assign(item, update.$set)
        modifiedCount += 1
      }
      return { modifiedCount }
    },
    find(query) {
      return cursor(items.filter(item => matches(item, query)))
    },
  }
}

function cursor(items) {
  return {
    sort(sortSpec) {
      const [[field, direction]] = Object.entries(sortSpec)
      items.sort((a, b) => direction < 0
        ? compareValues(b[field], a[field])
        : compareValues(a[field], b[field]))
      return this
    },
    limit(count) {
      items = items.slice(0, count)
      return this
    },
    async next() {
      return items[0] || null
    },
  }
}

function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => doc[key] === expected)
}

function compareValues(a, b) {
  const left = a?.getTime?.() ?? a ?? 0
  const right = b?.getTime?.() ?? b ?? 0
  if (left === right) return 0
  return left < right ? -1 : 1
}
