import { describe, expect, it, vi } from 'vitest'

vi.mock('@overleaf/metrics', () => ({
  default: { mongodb: { monitor: vi.fn() } },
}))

vi.mock('@overleaf/settings', () => ({
  default: {
    mongo: { url: 'mongodb://127.0.0.1/test', options: {} },
  },
}))

vi.mock('@overleaf/mongo-utils', () => ({
  default: { cleanupTestDatabase: vi.fn() },
}))

const createIndexCalls = []
const collectionNames = []

vi.mock('mongodb', () => {
  class ObjectId {
    constructor(value = '64a000000000000000000000') {
      this.value = value
    }

    toString() {
      return this.value
    }

    static isValid() {
      return true
    }
  }

  return {
    ObjectId,
    MongoClient: class MongoClient {
      db() {
        return {
          collection: name => {
            collectionNames.push(name)
            return {
              createIndex: vi.fn(async (...args) => {
                createIndexCalls.push({ collection: name, args })
              }),
            }
          },
        }
      }
    },
  }
})

const { db, ensureIndexes } = await import(
  '../../../../app/js/mongodb.js'
)

describe('agent context Mongo indexes', () => {
  it('declares agent context collections and creates scoped indexes', async () => {
    expect(db.aiMemories).toBeDefined()
    expect(db.aiMemorySuggestions).toBeDefined()
    expect(db.aiSessionSummaries).toBeDefined()
    expect(db.aiContextSnapshots).toBeDefined()

    await ensureIndexes()

    expect(collectionNames).toEqual(expect.arrayContaining([
      'aiMemories',
      'aiMemorySuggestions',
      'aiSessionSummaries',
      'aiContextSnapshots',
    ]))
    expect(createIndexCalls).toEqual(expect.arrayContaining([
      {
        collection: 'aiMemories',
        args: [{ userId: 1, scope: 1, status: 1, updatedAt: -1 }],
      },
      {
        collection: 'aiMemories',
        args: [{ userId: 1, projectId: 1, status: 1, updatedAt: -1 }],
      },
      {
        collection: 'aiMemorySuggestions',
        args: [{ userId: 1, status: 1, createdAt: -1 }],
      },
      {
        collection: 'aiSessionSummaries',
        args: [{ sessionId: 1, status: 1, createdAt: -1 }],
      },
      {
        collection: 'aiContextSnapshots',
        args: [{ sessionId: 1, turnId: 1 }],
      },
    ]))
  })
})
