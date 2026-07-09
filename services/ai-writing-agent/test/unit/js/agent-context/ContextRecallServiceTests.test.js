import { beforeEach, describe, expect, it } from 'vitest'

const { ContextRecallService } = await import(
  '../../../../app/js/agent-context/ContextRecallService.js'
)

describe('ContextRecallService', () => {
  let memories
  let summaries
  let service

  beforeEach(() => {
    memories = [
      memory({
        _id: 'global-1',
        userId: 'user-1',
        scope: 'global',
        projectId: null,
        content: 'Global preference.',
        updatedAt: new Date('2026-06-25T00:00:01.000Z'),
      }),
      memory({
        _id: 'project-1',
        userId: 'user-1',
        scope: 'project',
        projectId: 'project-1',
        content: 'Project preference.',
        updatedAt: new Date('2026-06-25T00:00:02.000Z'),
      }),
      memory({
        _id: 'deleted-1',
        userId: 'user-1',
        scope: 'project',
        projectId: 'project-1',
        content: 'Deleted preference.',
        status: 'deleted',
      }),
      memory({
        _id: 'other-user-1',
        userId: 'user-2',
        scope: 'project',
        projectId: 'project-1',
        content: 'Other user preference.',
      }),
      memory({
        _id: 'other-project-1',
        userId: 'user-1',
        scope: 'project',
        projectId: 'project-2',
        content: 'Other project preference.',
      }),
    ]
    summaries = [
      summary({
        _id: 'summary-1',
        sessionId: 'session-1',
        userId: 'user-1',
        projectId: 'project-1',
        summary: 'Earlier discussion about project citations and concise updates.',
        createdAt: new Date('2026-06-25T00:00:03.000Z'),
      }),
      summary({
        _id: 'summary-other-user',
        sessionId: 'session-2',
        userId: 'user-2',
        projectId: 'project-1',
        summary: 'Private other user summary.',
      }),
      summary({
        _id: 'summary-other-project',
        sessionId: 'session-3',
        userId: 'user-1',
        projectId: 'project-2',
        summary: 'Other project summary.',
      }),
    ]
    service = new ContextRecallService({
      memoriesCollection: collection(memories),
      summariesCollection: collection(summaries),
      now: () => new Date('2026-06-25T00:01:00.000Z'),
    })
  })

  it('recalls only active memories owned by the user and scoped to the project', async () => {
    const result = await service.recall({
      userId: 'user-1',
      projectId: 'project-1',
      maxMemories: 10,
      maxRecallChars: 1000,
    })

    expect(result.memories.map(item => item.content)).toEqual([
      'Project preference.',
      'Global preference.',
    ])
    expect(result.sourceRefs.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'memory', refId: 'project-1' }),
      expect.objectContaining({ type: 'memory', refId: 'global-1' }),
    ])
  })

  it('ranks by keyword score, project scope, source type, and recency', async () => {
    memories.push(
      memory({
        _id: 'global-keyword',
        userId: 'user-1',
        scope: 'global',
        projectId: null,
        content: 'Use citation style for citations.',
        updatedAt: new Date('2026-06-25T00:00:04.000Z'),
      }),
      memory({
        _id: 'project-keyword',
        userId: 'user-1',
        scope: 'project',
        projectId: 'project-1',
        content: 'Project citation style prefers IEEE citations.',
        updatedAt: new Date('2026-06-25T00:00:01.000Z'),
      })
    )

    const result = await service.recall({
      userId: 'user-1',
      projectId: 'project-1',
      query: 'citation style',
      maxMemories: 4,
      maxSummaries: 2,
      maxRecallChars: 2000,
    })

    expect(result.items.map(item => item.refId).slice(0, 3)).toEqual([
      'project-keyword',
      'global-keyword',
      'summary-1',
    ])
  })

  it('returns only authorized session summaries for the same project', async () => {
    const result = await service.recall({
      userId: 'user-1',
      projectId: 'project-1',
      query: 'discussion',
      maxMemories: 0,
      maxSummaries: 5,
      maxRecallChars: 1000,
    })

    expect(result.summaries.map(item => item._id)).toEqual(['summary-1'])
    expect(result.summaries.map(item => item.summary).join('\n'))
      .not.toContain('Private other user')
  })

  it('clamps recall results by character budget and records used memories', async () => {
    const result = await service.recall({
      userId: 'user-1',
      projectId: 'project-1',
      query: 'preference',
      maxMemories: 10,
      maxSummaries: 5,
      maxRecallChars: 30,
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0].content.length).toBeLessThanOrEqual(30)
    const usedMemory = memories.find(item => item._id === result.items[0].refId)
    expect(usedMemory).toMatchObject({
      lastUsedAt: new Date('2026-06-25T00:01:00.000Z'),
      useCount: 1,
    })
  })

  it('returns no recalled data when recall is disabled', async () => {
    const result = await service.recall({
      userId: 'user-1',
      projectId: 'project-1',
      recallEnabled: false,
    })

    expect(result.memories).toEqual([])
    expect(result.sourceRefs).toEqual([])
  })
})

function memory(fields) {
  return {
    _id: fields._id,
    userId: fields.userId,
    projectId: fields.projectId,
    scope: fields.scope,
    content: fields.content,
    status: fields.status || 'active',
    updatedAt: fields.updatedAt || new Date('2026-06-25T00:00:00.000Z'),
    lastUsedAt: null,
    useCount: 0,
  }
}

function summary(fields) {
  return {
    _id: fields._id,
    sessionId: fields.sessionId,
    userId: fields.userId,
    projectId: fields.projectId,
    summary: fields.summary,
    status: fields.status || 'active',
    createdAt: fields.createdAt || new Date('2026-06-25T00:00:00.000Z'),
    tokenEstimate: fields.tokenEstimate || 10,
  }
}

function collection(items) {
  return {
    find(query) {
      return cursor(items.filter(item => matches(item, query)))
    },
    async updateMany(query, update) {
      let modifiedCount = 0
      for (const item of items) {
        if (!matches(item, query)) continue
        if (update.$set) Object.assign(item, update.$set)
        if (update.$inc) {
          for (const [key, value] of Object.entries(update.$inc)) {
            item[key] = (item[key] || 0) + value
          }
        }
        modifiedCount += 1
      }
      return { modifiedCount }
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
    async toArray() {
      return items
    },
  }
}

function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') {
      return expected.some(option => matches(doc, option))
    }
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return expected.$in.includes(doc[key])
    }
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return doc[key] !== expected.$ne
    }
    return doc[key] === expected
  })
}

function compareValues(a, b) {
  const left = a?.getTime?.() ?? a ?? 0
  const right = b?.getTime?.() ?? b ?? 0
  if (left === right) return 0
  return left < right ? -1 : 1
}
