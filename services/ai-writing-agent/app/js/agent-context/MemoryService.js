import { ObjectId, db } from '../mongodb.js'
import { notFound, validationError } from './AgentContextErrors.js'
import { assertAgentContextContentSafe } from './ContentSafetyGuard.js'

const VALID_SCOPES = new Set(['global', 'project'])
const VALID_STATUSES = new Set(['active', 'disabled', 'deleted'])
const VALID_SOURCES = new Set(['manual', 'suggestion', 'migration'])
const DEFAULT_MAX_MEMORY_CHARS = 2000

export class MemoryService {
  constructor(options = {}) {
    this.memoriesCollection = options.memoriesCollection || db.aiMemories
    this.now = options.now || (() => new Date())
    this.maxMemoryChars = options.maxMemoryChars || DEFAULT_MAX_MEMORY_CHARS
  }

  async createMemory(input = {}) {
    const doc = this.buildMemoryDoc(input)
    await this.memoriesCollection.insertOne(doc)
    return doc
  }

  async listMemories(input = {}) {
    const userId = requireString(input.userId, 'userId')
    const query = {
      userId,
      status: input.includeDisabled ? { $ne: 'deleted' } : 'active',
    }
    if (input.scope === 'global') {
      query.scope = 'global'
    } else if (input.scope === 'project') {
      query.scope = 'project'
      query.projectId = requireString(input.projectId, 'projectId')
    } else if (input.projectId) {
      query.scope = { $in: ['global', 'project'] }
    }

    const memories = await this.memoriesCollection
      .find(query)
      .sort({ updatedAt: 1 })
      .toArray()

    if (input.scope === 'all' && input.projectId) {
      return memories.filter(memory => {
        return memory.scope === 'global' || memory.projectId === input.projectId
      })
    }
    return memories
  }

  async updateMemory(input = {}) {
    const memory = await this.findOwnedMemory(input.memoryId, input.userId)
    const update = {
      updatedAt: this.now(),
    }
    if (input.content !== undefined) {
      update.content = validateContent(input.content, this.maxMemoryChars)
    }
    if (input.status !== undefined) {
      if (!VALID_STATUSES.has(input.status)) {
        throw validationError('Invalid memory status')
      }
      update.status = input.status
      if (input.status === 'disabled') update.disabledAt = this.now()
    }
    await this.memoriesCollection.updateOne(
      { _id: memory._id, userId: memory.userId },
      { $set: update }
    )
    return { ...memory, ...update }
  }

  async deleteMemory(input = {}) {
    const memory = await this.findOwnedMemory(input.memoryId, input.userId)
    const now = this.now()
    await this.memoriesCollection.updateOne(
      { _id: memory._id, userId: memory.userId },
      {
        $set: {
          status: 'deleted',
          deletedAt: now,
          updatedAt: now,
        },
      }
    )
    return { ...memory, status: 'deleted', deletedAt: now, updatedAt: now }
  }

  buildMemoryDoc(input) {
    const now = this.now()
    const scope = input.scope || 'global'
    if (!VALID_SCOPES.has(scope)) {
      throw validationError('Invalid memory scope')
    }
    const source = input.source || 'manual'
    if (!VALID_SOURCES.has(source)) {
      throw validationError('Invalid memory source')
    }
    const projectId = scope === 'project'
      ? requireString(input.projectId, 'projectId')
      : null

    return {
      _id: input._id || new ObjectId(),
      userId: requireString(input.userId, 'userId'),
      projectId,
      scope,
      content: validateContent(input.content, this.maxMemoryChars),
      status: 'active',
      source,
      tags: Array.isArray(input.tags) ? input.tags.filter(Boolean) : [],
      createdFrom: input.createdFrom || {
        sessionId: input.sessionId || null,
        messageId: input.messageId || null,
        suggestionId: input.suggestionId || null,
      },
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
      deletedAt: null,
      lastUsedAt: null,
      useCount: 0,
    }
  }

  async findOwnedMemory(memoryId, userId) {
    const memory = await this.memoriesCollection.findOne({
      _id: memoryId,
      userId: requireString(userId, 'userId'),
    })
    if (!memory || memory.status === 'deleted') {
      throw notFound('Memory not found', 'MEMORY_NOT_FOUND')
    }
    return memory
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} is required`)
  }
  return value
}

function validateContent(value, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw validationError('Memory content is required')
  }
  if (value.length > maxLength) {
    throw validationError('Memory content exceeds maximum length')
  }
  return assertAgentContextContentSafe(value, 'Memory content')
}

export default MemoryService
