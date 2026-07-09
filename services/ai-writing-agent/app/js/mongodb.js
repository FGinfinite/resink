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
  aiAgentToolCalls: mongoDb.collection('aiAgentToolCalls'),
  aiAgentChangeSets: mongoDb.collection('aiAgentChangeSets'),
  aiAgentDraftChanges: mongoDb.collection('aiAgentDraftChanges'),
  aiAgentApplyOperations: mongoDb.collection('aiAgentApplyOperations'),
  aiPendingChanges: mongoDb.collection('aiPendingChanges'),
  aiCompletionRules: mongoDb.collection('aiCompletionRules'),
  aiAttachments: mongoDb.collection('aiAttachments'),
  aiFiles: mongoDb.collection('aiFiles'),
  aiSandboxSessions: mongoDb.collection('aiSandboxSessions'),
  aiSandboxArtifacts: mongoDb.collection('aiSandboxArtifacts'),
  aiAgentWorkspaces: mongoDb.collection('aiAgentWorkspaces'),
  aiAgentTeams: mongoDb.collection('aiAgentTeams'),
  aiAgentTasks: mongoDb.collection('aiAgentTasks'),
  aiAgentContextPacks: mongoDb.collection('aiAgentContextPacks'),
  aiAgentTaskResults: mongoDb.collection('aiAgentTaskResults'),
  aiAgentTeamEvents: mongoDb.collection('aiAgentTeamEvents'),
  aiMemories: mongoDb.collection('aiMemories'),
  aiMemorySuggestions: mongoDb.collection('aiMemorySuggestions'),
  aiSessionSummaries: mongoDb.collection('aiSessionSummaries'),
  aiContextSnapshots: mongoDb.collection('aiContextSnapshots'),
  aiPythonDependencyRequests: mongoDb.collection('aiPythonDependencyRequests'),
  aiPythonEnvironmentSnapshots: mongoDb.collection('aiPythonEnvironmentSnapshots'),
  aiPythonEnvironmentUsages: mongoDb.collection('aiPythonEnvironmentUsages'),
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
  await db.aiSessions.createIndex({
    projectId: 1,
    userId: 1,
    parentId: 1,
    status: 1,
    updatedAt: -1,
  })
  await db.aiSessions.createIndex({ expiresAt: 1 })
  await db.aiMessages.createIndex({ sessionId: 1, seq: 1 }, { unique: true })
  await db.aiAgentToolCalls.createIndex(
    { sessionId: 1, toolCallId: 1 },
    { unique: true }
  )
  await db.aiAgentToolCalls.createIndex({ sessionId: 1, createdAt: 1 })
  await db.aiAgentChangeSets.createIndex({ sessionId: 1, createdAt: -1 })
  await db.aiAgentChangeSets.createIndex({ projectId: 1, userId: 1, status: 1 })
  await db.aiAgentDraftChanges.createIndex({ changeSetId: 1, createdAt: 1 })
  await db.aiAgentDraftChanges.createIndex({ sessionId: 1, status: 1 })
  await db.aiAgentDraftChanges.createIndex({ projectId: 1, userId: 1, status: 1 })
  await db.aiAgentApplyOperations.createIndex({ changeId: 1, startedAt: -1 })
  await db.aiAgentApplyOperations.createIndex({ changeSetId: 1, startedAt: -1 })
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

  // Sandbox session orchestration indexes
  await db.aiSandboxSessions.createIndex({ userId: 1, createdAt: -1 })
  await db.aiSandboxSessions.createIndex({ projectId: 1, createdAt: -1 })
  await db.aiSandboxSessions.createIndex({ status: 1, updatedAt: -1 })
  await db.aiSandboxArtifacts.createIndex({ sessionId: 1 })
  await db.aiSandboxArtifacts.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0 }
  )
  await db.aiAgentWorkspaces.createIndex({ sessionId: 1, status: 1 })
  await db.aiAgentWorkspaces.createIndex({ projectId: 1, updatedAt: -1 })
  await db.aiAgentWorkspaces.createIndex({ expiresAt: 1 })
  await db.aiAgentTeams.createIndex({ rootSessionId: 1, status: 1, updatedAt: -1 })
  await db.aiAgentTeams.createIndex({ projectId: 1, userId: 1, status: 1, updatedAt: -1 })
  await db.aiAgentTasks.createIndex({ teamId: 1, status: 1, priority: -1 })
  await db.aiAgentTasks.createIndex({ rootSessionId: 1, status: 1, updatedAt: -1 })
  await db.aiAgentTasks.createIndex({ childSessionId: 1 }, { sparse: true })
  await db.aiAgentContextPacks.createIndex({ teamId: 1, taskId: 1 })
  await db.aiAgentContextPacks.createIndex({ projectId: 1, createdAt: -1 })
  await db.aiAgentTaskResults.createIndex({ teamId: 1, taskId: 1 })
  await db.aiAgentTeamEvents.createIndex({ teamId: 1, createdAt: 1 })
  await db.aiAgentTeamEvents.createIndex({ taskId: 1, createdAt: 1 }, { sparse: true })
  await db.aiMemories.createIndex({ userId: 1, scope: 1, status: 1, updatedAt: -1 })
  await db.aiMemories.createIndex({ userId: 1, projectId: 1, status: 1, updatedAt: -1 })
  await db.aiMemories.createIndex({ userId: 1, status: 1, content: 'text', tags: 'text' })
  await db.aiMemorySuggestions.createIndex({ userId: 1, status: 1, createdAt: -1 })
  await db.aiMemorySuggestions.createIndex({ sessionId: 1, status: 1, createdAt: -1 })
  await db.aiMemorySuggestions.createIndex({ expiresAt: 1 })
  await db.aiSessionSummaries.createIndex({ sessionId: 1, status: 1, createdAt: -1 })
  await db.aiSessionSummaries.createIndex({ projectId: 1, userId: 1, status: 1, createdAt: -1 })
  await db.aiContextSnapshots.createIndex({ sessionId: 1, turnId: 1 })
  await db.aiContextSnapshots.createIndex({ projectId: 1, userId: 1, createdAt: -1 })
  await db.aiPythonDependencyRequests.createIndex({ projectId: 1, status: 1, updatedAt: -1 })
  await db.aiPythonDependencyRequests.createIndex({ fingerprint: 1, projectId: 1 }, { unique: true })
  await db.aiPythonEnvironmentSnapshots.createIndex({ environmentKey: 1 }, { unique: true, sparse: true })
  await db.aiPythonEnvironmentSnapshots.createIndex({ skillName: 1, lockHash: 1 })
  await db.aiPythonEnvironmentUsages.createIndex({ environmentId: 1, projectId: 1, attachedAt: -1 })

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
