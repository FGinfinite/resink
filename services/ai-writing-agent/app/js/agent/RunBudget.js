import settings from '@overleaf/settings'

function getDefaults() {
  return settings.runBudget || {}
}

export class RunBudget {
  constructor(limits = {}) {
    // Sanitize input
    if (!limits || typeof limits !== 'object') limits = {}

    // Counters
    this.depth = 0
    this.delegations = 0
    this.llmCalls = 0
    this.toolCalls = 0
    this.totalTokens = 0
    this.startedAt = Date.now()

    // Wall time pause tracking
    this._pausedDurationMs = 0
    this._pausedAt = null

    // Helper to safely resolve a numeric limit
    const safeInt = (val, fallback) => {
      const n = val ?? fallback
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
    }

    // Limits (env/settings overridable)
    const defaults = getDefaults()
    this.maxDepth = safeInt(limits.maxDepth, safeInt(defaults.maxDepth, 1))
    this.maxDelegations = safeInt(limits.maxDelegations, safeInt(defaults.maxDelegations, 6))
    this.maxLLMCalls = safeInt(limits.maxLLMCalls, safeInt(defaults.maxLLMCalls, 30))
    this.maxToolCalls = safeInt(limits.maxToolCalls, safeInt(defaults.maxToolCalls, 70))
    this.maxTotalTokens = safeInt(limits.maxTotalTokens, safeInt(defaults.maxTotalTokens, 200_000))
    this.maxWallTimeMs = safeInt(limits.maxWallTimeMs, safeInt(defaults.maxWallTimeMs, 300_000))

    // Internal: track latest prompt_tokens (the most recent value includes all context)
    this._lastPromptTokens = 0
  }

  canDelegate(currentDepth) {
    return currentDepth < this.maxDepth && this.delegations < this.maxDelegations
  }

  recordDelegation() {
    this.delegations++
  }

  /**
   * Atomic check-and-consume: returns true and increments delegation count
   * if delegation is allowed, otherwise returns false without side effects.
   */
  tryConsumeDelegation(currentDepth) {
    if (!this.canDelegate(currentDepth)) return false
    this.recordDelegation()
    return true
  }

  canCallLLM() {
    return this.llmCalls < this.maxLLMCalls
  }

  recordLLMCall() {
    this.llmCalls++
  }

  /**
   * Atomic check-and-consume: returns true and increments LLM call count
   * if an LLM call is allowed, otherwise returns false without side effects.
   */
  tryConsumeLLMCall() {
    if (!this.canCallLLM()) return false
    this.recordLLMCall()
    return true
  }

  recordTokens(usage) {
    if (usage && typeof usage === 'object') {
      const completion = Number(usage.completion_tokens) || 0
      const prompt = Number(usage.prompt_tokens) || 0
      // Accumulate completion tokens (each turn generates new completions)
      if (completion > 0) this.totalTokens += completion
      // Track the latest prompt token count (not max).
      // The most recent prompt already includes all prior context,
      // so prompt + accumulated completion = true running cost.
      // Only update when value is positive to avoid resetting on missing data.
      if (prompt > 0) {
        this._lastPromptTokens = prompt
      }
    }
  }

  isTokenBudgetExceeded() {
    return (this._lastPromptTokens + this.totalTokens) >= this.maxTotalTokens
  }

  isWallTimeExceeded() {
    return this.getElapsedWallTimeMs() >= this.maxWallTimeMs
  }

  /**
   * Get effective elapsed wall time excluding paused duration.
   */
  getElapsedWallTimeMs() {
    const now = Date.now()
    const totalElapsed = now - this.startedAt
    const currentPause = this._pausedAt ? (now - this._pausedAt) : 0
    return Math.max(0, totalElapsed - this._pausedDurationMs - currentPause)
  }

  /**
   * Pause the wall time clock. Idempotent.
   */
  pauseWallTime() {
    if (this._pausedAt === null) {
      this._pausedAt = Date.now()
    }
  }

  /**
   * Resume the wall time clock. Idempotent.
   */
  resumeWallTime() {
    if (this._pausedAt !== null) {
      this._pausedDurationMs += Date.now() - this._pausedAt
      this._pausedAt = null
    }
  }

  canCallTools(batchSize = 1) {
    return (this.toolCalls + batchSize) <= this.maxToolCalls
  }

  recordToolCalls(count) {
    this.toolCalls += count
  }

  /**
   * Atomic check-and-consume: returns true and increments tool call count
   * if the batch is allowed, otherwise returns false without side effects.
   */
  tryConsumeToolCalls(batchSize = 1) {
    if (!this.canCallTools(batchSize)) return false
    this.recordToolCalls(batchSize)
    return true
  }
}
