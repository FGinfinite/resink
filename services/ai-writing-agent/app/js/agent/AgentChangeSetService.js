import { ObjectId } from '../mongodb.js'

const CHANGE_SET_STATUSES = new Set([
  'open',
  'review',
  'applying',
  'applied',
  'rejected',
  'conflict',
  'abandoned',
])

const DRAFT_CHANGE_STATUSES = new Set([
  'draft',
  'pending',
  'applying',
  'accepted',
  'rejected',
  'conflict',
  'stale',
])

const APPLY_OPERATION_STATUSES = new Set([
  'started',
  'succeeded',
  'failed',
  'conflict',
])

const CHANGE_TYPES = new Set(['edit', 'create', 'delete', 'artifact'])
const CHANGE_SOURCES = new Set(['agent-loop-v2'])
const CHANGE_SET_MODES = new Set(['review', 'auto'])

function nowFrom(clock) {
  return typeof clock === 'function' ? clock() : new Date()
}

function normalizeObjectId(value, field) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) {
    return new ObjectId(value)
  }
  throw new Error(`${field} must be a valid ObjectId`)
}

function requireString(value, field) {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`${field} is required`)
}

function sanitizeProvenance(provenance = {}) {
  const sanitized = {}
  for (const key of [
    'agentName',
    'toolName',
    'model',
    'profile',
    'teamId',
    'taskId',
    'capabilityName',
  ]) {
    if (typeof provenance[key] === 'string' && provenance[key].trim()) {
      sanitized[key] = provenance[key].trim().slice(0, 200)
    }
  }
  return sanitized
}

function serializeId(value) {
  return value?.toString?.() || value || null
}

export function serializeDraftChange(change) {
  if (!change) return null
  return {
    id: serializeId(change._id),
    changeSetId: serializeId(change.changeSetId),
    sessionId: serializeId(change.sessionId),
    turnId: change.turnId || null,
    toolCallId: change.toolCallId || null,
    parentSessionId: serializeId(change.parentSessionId),
    childSessionId: serializeId(change.childSessionId),
    projectId: change.projectId,
    userId: change.userId,
    type: change.type,
    source: change.source,
    path: change.path || null,
    docId: change.docId || null,
    entityId: change.entityId || null,
    baseVersion: change.baseVersion ?? null,
    position: change.position || null,
    oldText: change.oldText,
    newText: change.newText,
    newContent: change.newContent,
    content: change.content,
    status: change.status,
    createdAt: change.createdAt?.getTime?.() || null,
    updatedAt: change.updatedAt?.getTime?.() || null,
    appliedAt: change.appliedAt?.getTime?.() || null,
    rejectedAt: change.rejectedAt?.getTime?.() || null,
    conflictAt: change.conflictAt?.getTime?.() || null,
    conflictType: change.conflictType || null,
    conflictMessage: change.conflictMessage || null,
    appliedVersion: change.appliedVersion ?? null,
    wasRebased: change.wasRebased || false,
    provenance: change.provenance || {},
  }
}

export function serializeChangeSet(changeSet, draftChanges = []) {
  if (!changeSet) return null
  return {
    id: serializeId(changeSet._id),
    sessionId: serializeId(changeSet.sessionId),
    projectId: changeSet.projectId,
    userId: changeSet.userId,
    turnId: changeSet.turnId || null,
    status: changeSet.status,
    mode: changeSet.mode,
    createdAt: changeSet.createdAt?.getTime?.() || null,
    updatedAt: changeSet.updatedAt?.getTime?.() || null,
    closedAt: changeSet.closedAt?.getTime?.() || null,
    summary: changeSet.summary || null,
    changeIds: (changeSet.changeIds || []).map(serializeId),
    draftChanges: draftChanges.map(serializeDraftChange),
  }
}

export class AgentChangeSetService {
  constructor({ db, now } = {}) {
    if (!db) throw new Error('db is required')
    this.db = db
    this.now = now
  }

  async createChangeSet(input = {}) {
    const at = nowFrom(this.now)
    const sessionId = normalizeObjectId(input.sessionId, 'sessionId')
    const projectId = requireString(input.projectId, 'projectId')
    const userId = requireString(input.userId, 'userId')
    const status = input.status || 'open'
    const mode = input.mode || 'review'
    if (!CHANGE_SET_STATUSES.has(status)) {
      throw new Error(`Invalid change set status: ${status}`)
    }
    if (!CHANGE_SET_MODES.has(mode)) {
      throw new Error(`Invalid change set mode: ${mode}`)
    }

    const doc = {
      _id: input._id || new ObjectId(),
      sessionId,
      projectId,
      userId,
      turnId: input.turnId || null,
      status,
      mode,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      summary: input.summary || null,
      changeIds: [],
    }
    await this.db.aiAgentChangeSets.insertOne(doc)
    return doc
  }

  async getChangeSet({ changeSetId, sessionId, projectId, userId }) {
    const filter = this._authorizedChangeSetFilter({
      changeSetId,
      sessionId,
      projectId,
      userId,
    })
    return this.db.aiAgentChangeSets.findOne(filter)
  }

  async listChangeSets({ sessionId, projectId, userId, includeChanges = true }) {
    const filter = this._authorizedSessionFilter({ sessionId, projectId, userId })
    const changeSets = await this.db.aiAgentChangeSets
      .find(filter)
      .sort({ createdAt: 1 })
      .toArray()
    if (!includeChanges || changeSets.length === 0) {
      return changeSets.map(changeSet => ({ changeSet, draftChanges: [] }))
    }
    const changeSetIds = changeSets.map(changeSet => changeSet._id)
    const draftChanges = await this.db.aiAgentDraftChanges
      .find({ changeSetId: { $in: changeSetIds }, projectId, userId })
      .sort({ createdAt: 1 })
      .toArray()
    const changesBySet = new Map()
    for (const change of draftChanges) {
      const key = change.changeSetId.toString()
      const list = changesBySet.get(key) || []
      list.push(change)
      changesBySet.set(key, list)
    }
    return changeSets.map(changeSet => ({
      changeSet,
      draftChanges: changesBySet.get(changeSet._id.toString()) || [],
    }))
  }

  async createDraftChange(input = {}) {
    const at = nowFrom(this.now)
    const changeSet = await this.getChangeSet({
      changeSetId: input.changeSetId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      userId: input.userId,
    })
    if (!changeSet) throw new Error('Change set not found')

    const status = input.status || 'pending'
    const type = input.type || 'edit'
    const source = input.source || 'agent-loop-v2'
    if (!DRAFT_CHANGE_STATUSES.has(status)) {
      throw new Error(`Invalid draft change status: ${status}`)
    }
    if (!CHANGE_TYPES.has(type)) throw new Error(`Invalid draft change type: ${type}`)
    if (!CHANGE_SOURCES.has(source)) {
      throw new Error(`Invalid draft change source: ${source}`)
    }

    const doc = {
      _id: input._id || new ObjectId(),
      changeSetId: changeSet._id,
      sessionId: changeSet.sessionId,
      turnId: input.turnId || changeSet.turnId || null,
      toolCallId: input.toolCallId || null,
      parentSessionId: input.parentSessionId
        ? normalizeObjectId(input.parentSessionId, 'parentSessionId')
        : null,
      childSessionId: input.childSessionId
        ? normalizeObjectId(input.childSessionId, 'childSessionId')
        : null,
      projectId: changeSet.projectId,
      userId: changeSet.userId,
      type,
      source,
      path: input.path || null,
      docId: input.docId || null,
      entityId: input.entityId || null,
      baseVersion: input.baseVersion ?? null,
      position: input.position || null,
      oldText: input.oldText,
      newText: input.newText,
      newContent: input.newContent,
      content: input.content,
      status,
      createdAt: at,
      updatedAt: at,
      appliedAt: null,
      rejectedAt: null,
      conflictAt: null,
      conflictType: null,
      conflictMessage: null,
      appliedVersion: null,
      wasRebased: false,
      provenance: sanitizeProvenance(input.provenance),
    }

    await this.db.aiAgentDraftChanges.insertOne(doc)
    await this.db.aiAgentChangeSets.updateOne(
      { _id: changeSet._id },
      {
        $set: { status: 'review', updatedAt: at },
        $addToSet: { changeIds: doc._id },
      }
    )
    if (input.mirrorToSessionPendingChanges) {
      await this.mirrorDraftChangeToSessionPendingChange(doc)
    }
    return doc
  }

  async updateDraftStatus({ changeId, sessionId, projectId, userId, status, ...fields }) {
    if (!DRAFT_CHANGE_STATUSES.has(status)) {
      throw new Error(`Invalid draft change status: ${status}`)
    }
    const at = nowFrom(this.now)
    const filter = {
      _id: normalizeObjectId(changeId, 'changeId'),
      ...this._authorizedSessionFilter({ sessionId, projectId, userId }),
    }
    const set = {
      status,
      updatedAt: at,
      ...fields,
    }
    if (status === 'accepted') set.appliedAt = fields.appliedAt || at
    if (status === 'rejected') set.rejectedAt = fields.rejectedAt || at
    if (status === 'conflict') set.conflictAt = fields.conflictAt || at

    const result = await this.db.aiAgentDraftChanges.findOneAndUpdate(
      filter,
      { $set: set },
      { returnDocument: 'after' }
    )
    return result
  }

  async recordApplyOperation(input = {}) {
    const at = input.startedAt || nowFrom(this.now)
    const status = input.status || 'started'
    if (!APPLY_OPERATION_STATUSES.has(status)) {
      throw new Error(`Invalid apply operation status: ${status}`)
    }
    const doc = {
      _id: input._id || new ObjectId(),
      changeId: normalizeObjectId(input.changeId, 'changeId'),
      changeSetId: normalizeObjectId(input.changeSetId, 'changeSetId'),
      sessionId: normalizeObjectId(input.sessionId, 'sessionId'),
      projectId: requireString(input.projectId, 'projectId'),
      userId: requireString(input.userId, 'userId'),
      status,
      startedAt: at,
      finishedAt: input.finishedAt || null,
      errorCode: input.errorCode || null,
      errorMessage: input.errorMessage || null,
      appliedVersion: input.appliedVersion ?? null,
    }
    await this.db.aiAgentApplyOperations.insertOne(doc)
    return doc
  }

  async mirrorDraftChangeToSessionPendingChange(change) {
    const pendingChange = this.toPendingChange(change)
    await this.db.aiSessions.updateOne(
      {
        _id: change.sessionId,
        projectId: change.projectId,
        userId: change.userId,
      },
      {
        $addToSet: { pendingChanges: pendingChange },
        $set: { updatedAt: nowFrom(this.now) },
      }
    )
    return pendingChange
  }

  async markMirroredPendingChangeStatus({
    changeId,
    sessionId,
    projectId,
    userId,
    status,
    ...fields
  }) {
    const set = {
      'pendingChanges.$.status': status,
      updatedAt: nowFrom(this.now),
    }
    if (status === 'accepted') {
      set['pendingChanges.$.acceptedAt'] = fields.acceptedAt || nowFrom(this.now)
      set['pendingChanges.$.appliedVersion'] = fields.appliedVersion ?? null
      set['pendingChanges.$.wasRebased'] = fields.wasRebased || false
    }
    if (status === 'rejected') {
      set['pendingChanges.$.rejectedAt'] = fields.rejectedAt || nowFrom(this.now)
    }
    if (status === 'conflict') {
      set['pendingChanges.$.conflictAt'] = fields.conflictAt || nowFrom(this.now)
      set['pendingChanges.$.conflictType'] = fields.conflictType || 'UNKNOWN'
      set['pendingChanges.$.conflictMessage'] = fields.conflictMessage || null
    }
    return this.db.aiSessions.updateOne(
      {
        _id: normalizeObjectId(sessionId, 'sessionId'),
        projectId: requireString(projectId, 'projectId'),
        userId: requireString(userId, 'userId'),
        'pendingChanges.id': normalizeObjectId(changeId, 'changeId').toString(),
      },
      { $set: set }
    )
  }

  toPendingChange(change) {
    return {
      id: change._id.toString(),
      changeSetId: change.changeSetId.toString(),
      type: change.type,
      source: 'persistent-workspace',
      projectId: change.projectId,
      userId: change.userId,
      path: change.path,
      docId: change.docId,
      entityId: change.entityId,
      baseVersion: change.baseVersion,
      position: change.position,
      oldText: change.oldText,
      newText: change.newText,
      newContent: change.newContent,
      content: change.content,
      status: change.status,
      createdAt: change.createdAt?.getTime?.() || Date.now(),
      provenance: change.provenance || {},
    }
  }

  _authorizedSessionFilter({ sessionId, projectId, userId }) {
    return {
      sessionId: normalizeObjectId(sessionId, 'sessionId'),
      projectId: requireString(projectId, 'projectId'),
      userId: requireString(userId, 'userId'),
    }
  }

  _authorizedChangeSetFilter({ changeSetId, sessionId, projectId, userId }) {
    return {
      _id: normalizeObjectId(changeSetId, 'changeSetId'),
      ...this._authorizedSessionFilter({ sessionId, projectId, userId }),
    }
  }
}

export default AgentChangeSetService
