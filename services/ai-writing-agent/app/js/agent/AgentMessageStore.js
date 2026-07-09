function parseToolArguments(toolCall) {
  try {
    return JSON.parse(toolCall?.function?.arguments || '{}')
  } catch {
    return {}
  }
}

function summarizeToolResult(result) {
  if (!result) return null
  if (typeof result.output === 'string') return result.output.slice(0, 1000)
  if (typeof result.error === 'string') return result.error.slice(0, 1000)
  if (result.data?.summary && typeof result.data.summary === 'string') {
    return result.data.summary.slice(0, 1000)
  }
  if (result.success === true) return 'Tool completed successfully.'
  if (result.success === false) return 'Tool failed.'
  return null
}

function collectIds(value, keys) {
  const ids = new Set()
  const visit = item => {
    if (!item || typeof item !== 'object') return
    for (const [key, val] of Object.entries(item)) {
      if (keys.includes(key) && typeof val === 'string') ids.add(val)
      if (Array.isArray(val)) val.forEach(visit)
      else if (val && typeof val === 'object') visit(val)
    }
  }
  visit(value)
  return [...ids]
}

function serializeError(error) {
  if (!error) return null
  return {
    message: error.message || String(error),
    code: error.code || error.name || 'ERROR',
    status: error.status || error.info?.status || null,
  }
}

export class AgentMessageStore {
  constructor({ db, allocateSeq }) {
    this.db = db
    this.allocateSeq = allocateSeq
  }

  async startToolCall({ sessionId, messageId, toolCall, queued = false }) {
    const now = new Date()
    const doc = {
      sessionId,
      messageId,
      toolCallId: toolCall.id,
      name: toolCall.function?.name || 'unknown',
      arguments: parseToolArguments(toolCall),
      status: queued ? 'queued' : 'running',
      startedAt: queued ? null : now,
      createdAt: now,
      updatedAt: now,
    }

    await this.db.aiAgentToolCalls.updateOne(
      { sessionId, toolCallId: doc.toolCallId },
      { $setOnInsert: doc },
      { upsert: true }
    )
  }

  async markToolCallRunning({ sessionId, toolCallId }) {
    const now = new Date()
    await this.db.aiAgentToolCalls.updateOne(
      { sessionId, toolCallId },
      {
        $set: {
          status: 'running',
          startedAt: now,
          updatedAt: now,
        },
      }
    )
  }

  async finishToolCall({ sessionId, toolCallId, toolName, result }) {
    const now = new Date()
    const existing = await this.db.aiAgentToolCalls.findOne({
      sessionId,
      toolCallId,
    })
    const startedAt = existing?.startedAt || existing?.createdAt || now
    const durationMs = Math.max(now.getTime() - startedAt.getTime(), 0)

    await this.db.aiAgentToolCalls.updateOne(
      { sessionId, toolCallId },
      {
        $set: {
          name: toolName || existing?.name || 'unknown',
          status: result?.success === false ? 'error' : 'completed',
          resultSummary: summarizeToolResult(result),
          error: result?.success === false ? serializeError(result.error || result) : null,
          relatedChangeIds: collectIds(result, ['changeId', 'pendingChangeId']),
          relatedArtifactIds: collectIds(result, ['artifactId']),
          durationMs,
          finishedAt: now,
          updatedAt: now,
        },
        $setOnInsert: {
          sessionId,
          toolCallId,
          messageId: null,
          arguments: {},
          createdAt: now,
        },
      },
      { upsert: true }
    )
  }

  async markTurnFailed({ sessionId, error }) {
    const seq = await this.allocateSeq(sessionId, 1)
    const now = new Date()
    await this.db.aiMessages.insertOne({
      sessionId,
      seq,
      role: 'assistant',
      content: '',
      status: 'error',
      error: serializeError(error),
      timestamp: now,
    })
    await this.db.aiSessions.updateOne(
      { _id: sessionId },
      { $set: { updatedAt: now, lastTurnAt: now } }
    )
  }

  async saveSimpleTurn({ sessionId, userContent, assistantContent, contentBlocks, toolContext }) {
    const startSeq = await this.allocateSeq(sessionId, 2)
    const now = new Date()
    await this.db.aiMessages.insertMany([
      {
        sessionId,
        seq: startSeq,
        role: 'user',
        content: userContent,
        timestamp: now,
      },
      {
        sessionId,
        seq: startSeq + 1,
        role: 'assistant',
        content: assistantContent,
        contentBlocks: contentBlocks?.length > 0 ? contentBlocks : undefined,
        toolContext: toolContext?.length > 0 ? toolContext : undefined,
        timestamp: now,
      },
    ])
    await this.db.aiSessions.updateOne(
      { _id: sessionId },
      { $set: { updatedAt: now, lastTurnAt: now } }
    )
  }

  async listToolCalls(sessionId) {
    return this.db.aiAgentToolCalls
      .find({ sessionId })
      .sort({ createdAt: 1 })
      .toArray()
  }
}
