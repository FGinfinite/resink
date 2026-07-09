import { ObjectId, db } from '../mongodb.js'
import { MemoryService } from './MemoryService.js'
import { notFound, validationError } from './AgentContextErrors.js'

const VALID_SCOPES = new Set(['global', 'project'])
const DEFAULT_TTL_MS = 2592000000

export class MemorySuggestionService {
  constructor(options = {}) {
    this.suggestionsCollection =
      options.suggestionsCollection || db.aiMemorySuggestions
    this.memoryService = options.memoryService || new MemoryService({
      memoriesCollection: options.memoriesCollection || db.aiMemories,
      now: options.now,
    })
    this.now = options.now || (() => new Date())
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS
  }

  async createSuggestion(input = {}) {
    const now = this.now()
    const scope = input.scope || 'global'
    if (!VALID_SCOPES.has(scope)) {
      throw validationError('Invalid memory suggestion scope')
    }
    const doc = {
      _id: input._id || new ObjectId(),
      userId: requireString(input.userId, 'userId'),
      projectId: scope === 'project' ? input.projectId || null : null,
      sessionId: requireString(input.sessionId, 'sessionId'),
      messageId: input.messageId || null,
      proposedContent: requireString(input.proposedContent, 'proposedContent'),
      scope,
      reason: requireString(input.reason, 'reason'),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
      dismissedAt: null,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      memoryId: null,
    }
    await this.suggestionsCollection.insertOne(doc)
    return doc
  }

  async acceptSuggestion(input = {}) {
    const suggestion = await this.findPendingSuggestion(
      input.suggestionId,
      input.userId
    )
    await this.assertNotExpired(suggestion)
    const memory = await this.memoryService.createMemory({
      userId: suggestion.userId,
      projectId: suggestion.projectId,
      scope: suggestion.scope,
      content: suggestion.proposedContent,
      source: 'suggestion',
      suggestionId: suggestion._id,
      sessionId: suggestion.sessionId,
      messageId: suggestion.messageId,
    })
    const now = this.now()
    const update = {
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      memoryId: memory._id,
    }
    await this.suggestionsCollection.updateOne(
      { _id: suggestion._id, userId: suggestion.userId, status: 'pending' },
      { $set: update }
    )
    return { suggestion: { ...suggestion, ...update }, memory }
  }

  async dismissSuggestion(input = {}) {
    const suggestion = await this.findPendingSuggestion(
      input.suggestionId,
      input.userId
    )
    const now = this.now()
    const update = {
      status: 'dismissed',
      dismissedAt: now,
      updatedAt: now,
    }
    await this.suggestionsCollection.updateOne(
      { _id: suggestion._id, userId: suggestion.userId, status: 'pending' },
      { $set: update }
    )
    return { ...suggestion, ...update }
  }

  async assertNotExpired(suggestion) {
    if (suggestion.expiresAt > this.now()) return
    const now = this.now()
    await this.suggestionsCollection.updateOne(
      { _id: suggestion._id, userId: suggestion.userId, status: 'pending' },
      {
        $set: {
          status: 'expired',
          updatedAt: now,
        },
      }
    )
    throw notFound(
      'Memory suggestion expired',
      'MEMORY_SUGGESTION_EXPIRED'
    )
  }

  async listSuggestions(input = {}) {
    const userId = requireString(input.userId, 'userId')
    const status = input.status || 'pending'
    const query = { userId, status }
    if (input.projectId) {
      query.$or = [
        { scope: 'global' },
        { scope: 'project', projectId: input.projectId },
      ]
    }
    if (status === 'pending') {
      query.expiresAt = { $gt: this.now() }
    }
    return this.suggestionsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(input.limit || 100)
      .toArray()
  }

  async findPendingSuggestion(suggestionId, userId) {
    const suggestion = await this.suggestionsCollection.findOne({
      _id: suggestionId,
      userId: requireString(userId, 'userId'),
      status: 'pending',
    })
    if (!suggestion) {
      throw notFound(
        'Memory suggestion not found',
        'MEMORY_SUGGESTION_NOT_FOUND'
      )
    }
    return suggestion
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} is required`)
  }
  return value
}

export default MemorySuggestionService
