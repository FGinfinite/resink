import logger from '@overleaf/logger'
import settings from '@overleaf/settings'

function getConfirmationSettings() {
  return settings.confirmationChannel || {}
}

function getConfirmationTimeoutMs() {
  const confirmationSettings = getConfirmationSettings()
  return (
    confirmationSettings.defaultTimeoutMs ??
    confirmationSettings.timeout ??
    30 * 60 * 1000
  )
}

function getMaxPendingConfirmations() {
  return getConfirmationSettings().maxPending ?? 500
}

function getMaxEarlyConfirmations() {
  return getConfirmationSettings().maxEarlyConfirmations ?? 100
}

function getEarlyConfirmationTtlMs() {
  return getConfirmationSettings().earlyTtlMs ?? 30_000
}

function getFinalizedTtlMs() {
  return getConfirmationSettings().finalizedTtlMs ?? 60_000
}

/**
 * ConfirmationChannel bridges the AgentLoop (SSE stream) and the confirmation
 * HTTP endpoint. When a tool returns a change that needs user confirmation,
 * AgentLoop calls waitForConfirmation() which blocks via a Promise. The
 * confirmation HTTP handler calls confirm() to resolve or reject that Promise.
 */
export class ConfirmationChannel {
  /**
   * @param {object} [options]
   * @param {number} [options.timeout] - Timeout in ms before auto-reject (default 30 min)
   */
  constructor(options = {}) {
    this.timeout = options.timeout ?? getConfirmationTimeoutMs()
    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this._pending = new Map()
    // Cache for early confirmations (confirm arrived before waitForConfirmation)
    /** @type {Map<string, { action: string, reason?: string }>} */
    this._earlyConfirmations = new Map()
    this._aborted = false
    /** @type {Map<string, number>} changeId -> finalized timestamp */
    this._finalized = new Map()
  }

  _pruneFinalized(now = Date.now()) {
    for (const [id, ts] of this._finalized) {
      if (
        now - ts >=
        getFinalizedTtlMs()
      ) {
        this._finalized.delete(id)
      }
    }
  }

  /**
   * Remove expired entries from _earlyConfirmations.
   * Called at the entry of confirm() and waitForConfirmation().
   */
  _pruneExpiredEarly(now = Date.now()) {
    for (const [id, entry] of this._earlyConfirmations) {
      if (
        now - entry.createdAt >=
        getEarlyConfirmationTtlMs()
      ) {
        this._earlyConfirmations.delete(id)
      }
    }
  }

  /**
   * Block until the user confirms or rejects a change.
   * @param {string} changeId
   * @returns {Promise<{ action: 'accept'|'reject', reason?: string }>}
   */
  waitForConfirmation(changeId) {
    if (this._aborted) {
      return Promise.resolve({ action: 'reject', reason: 'Channel aborted' })
    }

    this._pruneExpiredEarly()

    // Reject when too many pending confirmations to prevent unbounded memory growth
    if (
      this._pending.size >=
      getMaxPendingConfirmations()
    ) {
      this._finalized.set(changeId, Date.now())
      this._pruneFinalized()
      logger.warn(
        { changeId, size: this._pending.size },
        'Too many pending confirmations, rejecting'
      )
      return Promise.resolve({ action: 'reject', reason: 'Too many pending confirmations' })
    }

    // Check if confirmation arrived early (before this call)
    const early = this._earlyConfirmations.get(changeId)
    if (early) {
      this._earlyConfirmations.delete(changeId)
      // Discard expired early confirmations
      if (
        Date.now() - early.createdAt <
        getEarlyConfirmationTtlMs()
      ) {
        return Promise.resolve({ action: early.action, reason: early.reason })
      }
      // Expired, fall through to create a new promise
    }

    // If a previous wait for the same changeId exists, supersede it:
    // clear old timer and reject old promise to prevent leaks and races.
    const existing = this._pending.get(changeId)
    if (existing) {
      clearTimeout(existing.timer)
      existing.reject(new Error('superseded by new wait'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(changeId)
        this._finalized.set(changeId, Date.now())
        this._pruneFinalized()
        logger.warn({ changeId }, 'Confirmation timed out, auto-rejecting')
        resolve({ action: 'reject', reason: 'Confirmation timed out' })
      }, this.timeout)

      this._pending.set(changeId, { resolve, reject, timer })
    })
  }

  /**
   * Confirm or reject a change (called from HTTP endpoint).
   * @param {string} changeId
   * @param {'accept'|'reject'} action
   * @param {string} [reason]
   * @returns {boolean} Whether a pending confirmation was found
   */
  confirm(changeId, action, reason) {
    this._pruneExpiredEarly()

    // Reject confirmations for already-finalized (timed out or resolved) changeIds
    if (this._finalized.has(changeId)) {
      const ts = this._finalized.get(changeId)
      if (
        Date.now() - ts <
        getFinalizedTtlMs()
      ) {
        return false
      }
      this._finalized.delete(changeId)
    }

    const entry = this._pending.get(changeId)
    if (!entry) {
      // If no pending promise yet, cache the confirmation for later pickup
      if (
        this._earlyConfirmations.size >=
        getMaxEarlyConfirmations()
      ) {
        logger.warn(
          { changeId, size: this._earlyConfirmations.size },
          'Early confirmation cache full, discarding'
        )
        return false
      }
      this._earlyConfirmations.set(changeId, { action, reason, createdAt: Date.now() })
      return true
    }

    clearTimeout(entry.timer)
    this._pending.delete(changeId)
    entry.resolve({ action, reason })
    this._finalized.set(changeId, Date.now())
    this._pruneFinalized()
    return true
  }

  /**
   * Abort all pending confirmations (called when SSE stream ends or errors).
   * All waiting Promises resolve as 'reject'.
   */
  abort() {
    this._aborted = true
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer)
      entry.resolve({ action: 'reject', reason: 'Stream aborted' })
    }
    this._pending.clear()
    this._earlyConfirmations.clear()
    this._finalized.clear()
  }

  /**
   * Check if there are any pending confirmations.
   * @returns {boolean}
   */
  hasPending() {
    return this._pending.size > 0
  }
}

export default ConfirmationChannel
