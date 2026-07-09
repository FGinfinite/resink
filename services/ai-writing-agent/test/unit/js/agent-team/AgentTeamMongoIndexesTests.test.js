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

describe('agent team Mongo indexes', () => {
  it('declares agent team collections and creates reload indexes', async () => {
    expect(db.aiAgentTeams).toBeDefined()
    expect(db.aiAgentTasks).toBeDefined()
    expect(db.aiAgentContextPacks).toBeDefined()
    expect(db.aiAgentTaskResults).toBeDefined()
    expect(db.aiAgentTeamEvents).toBeDefined()

    await ensureIndexes()

    expect(collectionNames).toEqual(expect.arrayContaining([
      'aiAgentTeams',
      'aiAgentTasks',
      'aiAgentContextPacks',
      'aiAgentTaskResults',
      'aiAgentTeamEvents',
    ]))
    expect(createIndexCalls).toEqual(expect.arrayContaining([
      { collection: 'aiAgentTeams', args: [{ rootSessionId: 1, status: 1, updatedAt: -1 }] },
      { collection: 'aiAgentTasks', args: [{ teamId: 1, status: 1, priority: -1 }] },
      { collection: 'aiAgentContextPacks', args: [{ teamId: 1, taskId: 1 }] },
      { collection: 'aiAgentTaskResults', args: [{ teamId: 1, taskId: 1 }] },
      { collection: 'aiAgentTeamEvents', args: [{ teamId: 1, createdAt: 1 }] },
    ]))
  })
})
