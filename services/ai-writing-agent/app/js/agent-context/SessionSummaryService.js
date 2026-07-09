import { ObjectId, db } from '../mongodb.js'
import { validationError } from './AgentContextErrors.js'

export class SessionSummaryService {
  constructor(options = {}) {
    this.summariesCollection =
      options.summariesCollection || db.aiSessionSummaries
    this.now = options.now || (() => new Date())
  }

  async createSummary(input = {}) {
    const now = this.now()
    const sessionId = requireString(input.sessionId, 'sessionId')
    const userId = requireString(input.userId, 'userId')
    await this.summariesCollection.updateMany(
      { sessionId, userId, status: 'active' },
      {
        $set: {
          status: 'superseded',
          supersededAt: now,
          updatedAt: now,
        },
      }
    )
    const doc = {
      _id: input._id || new ObjectId(),
      sessionId,
      projectId: requireString(input.projectId, 'projectId'),
      userId,
      summary: requireString(input.summary, 'summary'),
      sourceMessageRange: input.sourceMessageRange || { fromSeq: 0, toSeq: 0 },
      tokenEstimate: Number.isFinite(input.tokenEstimate)
        ? input.tokenEstimate
        : 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      supersededAt: null,
    }
    await this.summariesCollection.insertOne(doc)
    return doc
  }

  async findLatestSummary(input = {}) {
    const sessionId = requireString(input.sessionId, 'sessionId')
    const userId = requireString(input.userId, 'userId')
    return this.summariesCollection
      .find({ sessionId, userId, status: 'active' })
      .sort({ createdAt: -1 })
      .limit(1)
      .next()
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} is required`)
  }
  return value
}

export default SessionSummaryService
