import { ObjectId, db } from '../mongodb.js'
import { validationError } from './AgentContextErrors.js'

const ALLOWED_SOURCE_TYPES = new Set([
  'project-instructions',
  'memory',
  'session-summary',
  'recall',
])

export class ContextSnapshotService {
  constructor(options = {}) {
    this.snapshotsCollection = options.snapshotsCollection || db.aiContextSnapshots
    this.now = options.now || (() => new Date())
  }

  async createSnapshot(input = {}) {
    const sourceRefs = sanitizeSourceRefs(input.sourceRefs || [])
    const doc = {
      _id: input._id || new ObjectId(),
      sessionId: requireString(input.sessionId, 'sessionId'),
      projectId: requireString(input.projectId, 'projectId'),
      userId: requireString(input.userId, 'userId'),
      turnId: requireString(input.turnId, 'turnId'),
      messageId: input.messageId || null,
      sourceRefs,
      totals: summarize(sourceRefs),
      createdAt: this.now(),
    }
    await this.snapshotsCollection.insertOne(doc)
    return doc
  }

  async findSnapshot(input = {}) {
    const sessionId = requireString(input.sessionId, 'sessionId')
    const userId = requireString(input.userId, 'userId')
    const turnId = requireString(input.turnId, 'turnId')
    return this.snapshotsCollection.findOne({
      sessionId,
      userId,
      turnId,
    })
  }
}

function sanitizeSourceRefs(sourceRefs) {
  if (!Array.isArray(sourceRefs)) {
    throw validationError('sourceRefs must be an array')
  }
  return sourceRefs.map(ref => {
    if (!ALLOWED_SOURCE_TYPES.has(ref.type)) {
      throw validationError('Invalid context source ref type')
    }
    return {
      type: ref.type,
      refId: requireString(ref.refId, 'refId'),
      path: ref.path || null,
      scope: ref.scope || 'session',
      tokenEstimate: Number.isFinite(ref.tokenEstimate)
        ? ref.tokenEstimate
        : 0,
      included: ref.included !== false,
      reason: typeof ref.reason === 'string' ? ref.reason : '',
    }
  })
}

function summarize(sourceRefs) {
  return {
    sourceCount: sourceRefs.length,
    tokenEstimate: sourceRefs.reduce(
      (sum, ref) => sum + (ref.tokenEstimate || 0),
      0
    ),
    memoryCount: sourceRefs.filter(ref => ref.type === 'memory').length,
    recalledCount: sourceRefs.filter(ref => ref.type === 'recall').length,
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${field} is required`)
  }
  return value
}

export default ContextSnapshotService
