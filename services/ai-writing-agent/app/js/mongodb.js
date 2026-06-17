// @ts-check

import Metrics from '@overleaf/metrics'
import Settings from '@overleaf/settings'
import MongoUtils from '@overleaf/mongo-utils'
import { MongoClient } from 'mongodb'

export { ObjectId } from 'mongodb'

export const mongoClient = new MongoClient(
  Settings.mongo.url,
  Settings.mongo.options
)
const mongoDb = mongoClient.db()

export const db = {
  aiSessions: mongoDb.collection('aiSessions'),
  aiMessages: mongoDb.collection('aiMessages'),
  aiPendingChanges: mongoDb.collection('aiPendingChanges'),
  aiProjectRules: mongoDb.collection('aiProjectRules'),
  aiCompletionRules: mongoDb.collection('aiCompletionRules'),
  aiAttachments: mongoDb.collection('aiAttachments'),
  aiFiles: mongoDb.collection('aiFiles'),
  aiModelConfigs: mongoDb.collection('aiModelConfigs'),
  aiModelSlots: mongoDb.collection('aiModelSlots'),
  aiSystemConfig: mongoDb.collection('aiSystemConfig'),
  appConfigValues: mongoDb.collection('appConfigValues'),
  appConfigRevisions: mongoDb.collection('appConfigRevisions'),
  appConfigAuditLogs: mongoDb.collection('appConfigAuditLogs'),
}

Metrics.mongodb.monitor(mongoClient)

/**
 * Ensure indexes for all AI collections.
 * Called once during server startup.
 */
export async function ensureIndexes() {
  await db.aiSessions.createIndex({ parentId: 1 })
  await db.aiSessions.createIndex({ rootSessionId: 1 })
  await db.aiSessions.createIndex({ projectId: 1, parentId: 1, status: 1 })
  await db.aiMessages.createIndex({ sessionId: 1, seq: 1 }, { unique: true })
  await db.aiProjectRules.createIndex({ projectId: 1 }, { unique: true })
  await db.aiCompletionRules.createIndex({ projectId: 1 }, { unique: true })
  await db.aiAttachments.createIndex({ sessionId: 1 })
  await db.aiAttachments.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  )
  // aiFiles indexes
  await db.aiFiles.createIndex({ userId: 1 })
  await db.aiFiles.createIndex({ sessionId: 1 })
  await db.aiFiles.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  )

  // Model config indexes
  await db.aiModelConfigs.createIndex({ enabled: 1 })
  await db.aiModelSlots.createIndex({ slug: 1 }, { unique: true })
  await db.aiModelSlots.createIndex({ sortOrder: 1 })
  await db.aiSystemConfig.createIndex({ key: 1 }, { unique: true })
  await db.appConfigValues.createIndex({ service: 1, key: 1 }, { unique: true })
  await db.appConfigRevisions.createIndex({ service: 1, key: 1, version: -1 })
  await db.appConfigAuditLogs.createIndex({ service: 1, key: 1, createdAt: -1 })
}

/**
 * Atomically allocate sequential message numbers for a session.
 * Uses findOneAndUpdate + $inc for concurrency safety.
 * @param {import('mongodb').ObjectId} sessionId
 * @param {number} count - Number of seq values to allocate
 * @returns {Promise<number>} The first allocated seq value
 */
export async function allocateSeq(sessionId, count = 1) {
  const result = await db.aiSessions.findOneAndUpdate(
    { _id: sessionId },
    { $inc: { _nextSeq: count } },
    { returnDocument: 'before', projection: { _nextSeq: 1 } }
  )
  return result?._nextSeq || 1
}

export async function cleanupTestDatabase() {
  await MongoUtils.cleanupTestDatabase(mongoClient)
}
