import { db } from '../mongodb.js'

const DEFAULT_MAX_MEMORIES = 12
const DEFAULT_MAX_SUMMARIES = 3
const DEFAULT_MAX_RECALL_CHARS = 6000

export class ContextRecallService {
  constructor(options = {}) {
    this.memoriesCollection = options.memoriesCollection || db.aiMemories
    this.summariesCollection =
      options.summariesCollection || db.aiSessionSummaries
    this.now = options.now || (() => new Date())
  }

  async recall(input = {}) {
    if (input.recallEnabled === false || !input.userId) {
      return emptyRecall()
    }

    const maxMemories = clampCount(input.maxMemories, DEFAULT_MAX_MEMORIES)
    const maxSummaries = clampCount(input.maxSummaries, DEFAULT_MAX_SUMMARIES)
    const maxRecallChars = Math.max(
      0,
      Number.isInteger(input.maxRecallChars)
        ? input.maxRecallChars
        : DEFAULT_MAX_RECALL_CHARS
    )
    if ((maxMemories === 0 && maxSummaries === 0) || maxRecallChars === 0) {
      return emptyRecall()
    }

    const [memoryCandidates, summaryCandidates] = await Promise.all([
      this.loadMemoryCandidates(input, maxMemories),
      this.loadSummaryCandidates(input, maxSummaries),
    ])
    const queryTerms = tokenize(input.query || input.userMessage || '')
    const ranked = [
      ...memoryCandidates.map(memory => rankMemory(memory, queryTerms, input.projectId)),
      ...summaryCandidates.map(summary => rankSummary(summary, queryTerms)),
    ].sort(compareRankedItems)

    const selected = selectWithinBudget(ranked, {
      maxMemories,
      maxSummaries,
      maxRecallChars,
    })
    await this.recordMemoryUsage(selected, input.userId)

    return {
      items: selected.map(stripSource),
      memories: selected
        .filter(item => item.type === 'memory')
        .map(item => item.source),
      summaries: selected
        .filter(item => item.type === 'summary')
        .map(item => item.source),
      sourceRefs: selected.map(item => ({
        type: item.type === 'summary' ? 'session-summary' : 'memory',
        refId: item.refId,
        scope: item.scope,
        path: null,
        included: true,
        tokenEstimate: Math.ceil(item.content.length / 4),
        reason: 'context recall',
      })),
    }
  }

  async loadMemoryCandidates(input, maxMemories) {
    if (maxMemories === 0) return []
    const query = {
      userId: input.userId,
      status: 'active',
      $or: [{ scope: 'global' }],
    }
    if (input.projectId) {
      query.$or.push({ scope: 'project', projectId: input.projectId })
    }
    return this.memoriesCollection
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(Math.max(maxMemories * 3, maxMemories))
      .toArray()
  }

  async loadSummaryCandidates(input, maxSummaries) {
    if (maxSummaries === 0 || !input.projectId) return []
    return this.summariesCollection
      .find({
        userId: input.userId,
        projectId: input.projectId,
        status: 'active',
      })
      .sort({ createdAt: -1 })
      .limit(Math.max(maxSummaries * 3, maxSummaries))
      .toArray()
  }

  async recordMemoryUsage(selected, userId) {
    const memoryIds = selected
      .filter(item => item.type === 'memory')
      .map(item => item.refId)
    if (memoryIds.length === 0) return
    await this.memoriesCollection.updateMany(
      { _id: { $in: memoryIds }, userId },
      {
        $set: { lastUsedAt: this.now() },
        $inc: { useCount: 1 },
      }
    )
  }
}

function clampCount(value, fallback) {
  return Math.max(
    0,
    Math.min(Number.isInteger(value) ? value : fallback, fallback)
  )
}

function rankMemory(memory, queryTerms, projectId) {
  const scopeScore =
    memory.scope === 'project' && memory.projectId === projectId ? 40 : 10
  const keywordScore = scoreText(memory.content, queryTerms)
  const recency = dateScore(memory.updatedAt)
  return {
    type: 'memory',
    refId: memory._id?.toString?.() || memory._id,
    scope: memory.scope,
    content: String(memory.content || ''),
    score: keywordScore * 100 + scopeScore + recency,
    source: memory,
  }
}

function rankSummary(summary, queryTerms) {
  const content = String(summary.summary || '')
  return {
    type: 'summary',
    refId: summary._id?.toString?.() || summary._id,
    scope: 'session',
    content,
    score: scoreText(content, queryTerms) * 100 + dateScore(summary.createdAt),
    source: summary,
  }
}

function selectWithinBudget(ranked, limits) {
  const selected = []
  const counts = { memory: 0, summary: 0 }
  let charCount = 0
  for (const item of ranked) {
    if (item.type === 'memory' && counts.memory >= limits.maxMemories) continue
    if (item.type === 'summary' && counts.summary >= limits.maxSummaries) continue
    if (item.content.length > limits.maxRecallChars) continue
    if (charCount + item.content.length > limits.maxRecallChars) continue
    selected.push(item)
    counts[item.type] += 1
    charCount += item.content.length
  }
  return selected
}

function stripSource(item) {
  return {
    type: item.type,
    refId: item.refId,
    scope: item.scope,
    content: item.content,
    score: item.score,
  }
}

function compareRankedItems(a, b) {
  if (b.score !== a.score) return b.score - a.score
  if (a.type !== b.type) return a.type === 'memory' ? -1 : 1
  return 0
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(term => term.trim())
    .filter(term => term.length >= 2)
}

function scoreText(text, terms) {
  if (terms.length === 0) return 0
  const lower = String(text || '').toLowerCase()
  return terms.reduce(
    (score, term) => score + (lower.includes(term) ? 1 : 0),
    0
  )
}

function dateScore(date) {
  const time = date?.getTime?.() || 0
  return Math.min(time / 1000000000000, 2)
}

function emptyRecall() {
  return {
    items: [],
    memories: [],
    summaries: [],
    sourceRefs: [],
  }
}

export default ContextRecallService
