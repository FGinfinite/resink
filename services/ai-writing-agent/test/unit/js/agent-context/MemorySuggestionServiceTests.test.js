import { beforeEach, describe, expect, it } from 'vitest'

const { MemorySuggestionService } = await import(
  '../../../../app/js/agent-context/MemorySuggestionService.js'
)

describe('MemorySuggestionService', () => {
  let suggestions
  let memories
  let service

  beforeEach(() => {
    suggestions = []
    memories = []
    service = new MemorySuggestionService({
      suggestionsCollection: collection(suggestions, 'suggestion'),
      memoriesCollection: collection(memories, 'memory'),
      now: () => new Date('2026-06-25T00:00:00.000Z'),
      ttlMs: 1000,
    })
  })

  it('creates pending suggestions with expiry', async () => {
    const suggestion = await service.createSuggestion({
      userId: 'user-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      proposedContent: 'Remember to answer in Chinese.',
      scope: 'project',
      reason: 'User explicitly corrected language.',
    })

    expect(suggestion).toMatchObject({
      userId: 'user-1',
      projectId: 'project-1',
      status: 'pending',
      expiresAt: new Date('2026-06-25T00:00:01.000Z'),
    })
  })

  it('accepts a user-owned pending suggestion by creating a memory', async () => {
    const suggestion = await service.createSuggestion({
      userId: 'user-1',
      projectId: null,
      sessionId: 'session-1',
      proposedContent: 'Prefer direct answers.',
      scope: 'global',
      reason: 'Repeated correction.',
    })

    const accepted = await service.acceptSuggestion({
      suggestionId: suggestion._id,
      userId: 'user-1',
    })

    expect(accepted.suggestion).toMatchObject({
      status: 'accepted',
      memoryId: accepted.memory._id,
    })
    expect(accepted.memory).toMatchObject({
      userId: 'user-1',
      scope: 'global',
      status: 'active',
      source: 'suggestion',
      content: 'Prefer direct answers.',
    })
  })

  it('dismisses a user-owned suggestion without creating memory', async () => {
    const suggestion = await service.createSuggestion({
      userId: 'user-1',
      sessionId: 'session-1',
      proposedContent: 'Do not store.',
      scope: 'global',
      reason: 'Noisy.',
    })

    await service.dismissSuggestion({
      suggestionId: suggestion._id,
      userId: 'user-1',
    })

    expect(suggestions[0].status).toBe('dismissed')
    expect(memories).toEqual([])
  })

  it('rejects suggestions owned by another user', async () => {
    const suggestion = await service.createSuggestion({
      userId: 'user-2',
      sessionId: 'session-1',
      proposedContent: 'Private.',
      scope: 'global',
      reason: 'Private.',
    })

    let error
    try {
      await service.acceptSuggestion({
        suggestionId: suggestion._id,
        userId: 'user-1',
      })
    } catch (err) {
      error = err
    }
    expect(error).toMatchObject({ code: 'MEMORY_SUGGESTION_NOT_FOUND' })
  })

  it('rejects expired suggestions instead of creating memories', async () => {
    suggestions.push({
      _id: 'suggestion-expired',
      userId: 'user-1',
      projectId: null,
      sessionId: 'session-1',
      messageId: null,
      proposedContent: 'Expired preference.',
      scope: 'global',
      reason: 'Old signal.',
      status: 'pending',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      updatedAt: new Date('2026-06-24T00:00:00.000Z'),
      acceptedAt: null,
      dismissedAt: null,
      expiresAt: new Date('2026-06-24T00:00:01.000Z'),
      memoryId: null,
    })

    let error
    try {
      await service.acceptSuggestion({
        suggestionId: 'suggestion-expired',
        userId: 'user-1',
      })
    } catch (err) {
      error = err
    }

    expect(error).toMatchObject({ code: 'MEMORY_SUGGESTION_EXPIRED' })
    expect(memories).toEqual([])
    expect(suggestions[0].status).toBe('expired')
  })

  it('lists only unexpired user-owned pending suggestions in scope', async () => {
    await service.createSuggestion({
      userId: 'user-1',
      projectId: null,
      sessionId: 'session-1',
      proposedContent: 'Global pending.',
      scope: 'global',
      reason: 'Global.',
    })
    await service.createSuggestion({
      userId: 'user-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      proposedContent: 'Project pending.',
      scope: 'project',
      reason: 'Project.',
    })
    await service.createSuggestion({
      userId: 'user-2',
      projectId: 'project-1',
      sessionId: 'session-2',
      proposedContent: 'Other user.',
      scope: 'project',
      reason: 'Private.',
    })
    suggestions.push({
      _id: 'suggestion-expired',
      userId: 'user-1',
      projectId: 'project-1',
      sessionId: 'session-1',
      proposedContent: 'Expired.',
      scope: 'project',
      reason: 'Old.',
      status: 'pending',
      createdAt: new Date('2026-06-24T00:00:00.000Z'),
      expiresAt: new Date('2026-06-24T00:00:01.000Z'),
    })

    const result = await service.listSuggestions({
      userId: 'user-1',
      projectId: 'project-1',
    })

    expect(result.map(suggestion => suggestion.proposedContent).sort()).toEqual([
      'Global pending.',
      'Project pending.',
    ].sort())
  })
})

function collection(items, prefix) {
  return {
    async insertOne(doc) {
      items.push({ _id: `${prefix}-${items.length + 1}`, ...doc })
      return { insertedId: items.at(-1)._id }
    },
    async findOne(query) {
      return items.find(item => matches(item, query)) || null
    },
    async updateOne(query, update) {
      const doc = items.find(item => matches(item, query))
      if (!doc) return { matchedCount: 0, modifiedCount: 0 }
      if (update.$set) Object.assign(doc, update.$set)
      return { matchedCount: 1, modifiedCount: 1 }
    },
    find(query) {
      return cursor(items.filter(item => matches(item, query)))
    },
  }
}

function matches(doc, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') {
      return expected.some(option => matches(doc, option))
    }
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return doc[key] > expected.$gt
    }
    return doc[key] === expected
  })
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

function compareValues(a, b) {
  const left = a?.getTime?.() ?? a ?? 0
  const right = b?.getTime?.() ?? b ?? 0
  if (left === right) return 0
  return left < right ? -1 : 1
}
