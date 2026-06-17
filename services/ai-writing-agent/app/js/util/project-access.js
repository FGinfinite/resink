import settings from '@overleaf/settings'

const PROJECT_ID_RE = /^[0-9a-fA-F]{24}$/
const USER_ID_RE = /^[0-9a-fA-F]{24}$/

// Short-lived cache for project access checks (userId:projectId → { result, expiry })
const _projectAccessCache = new Map()
const PROJECT_ACCESS_CACHE_TTL = settings.projectAccess?.cacheTtlMs || 10_000 // 10 seconds

/**
 * Verify the user has read access to the project via Web internal API.
 * Uses the /internal/project/:id/membership endpoint.
 * Returns true if authorized, false otherwise.
 */
export async function checkProjectAccess(projectId, userId) {
  // Validate format to prevent path traversal / SSRF
  if (!PROJECT_ID_RE.test(projectId) || !USER_ID_RE.test(userId)) {
    return false
  }

  const cacheKey = `${userId}:${projectId}`
  const cached = _projectAccessCache.get(cacheKey)
  if (cached && Date.now() < cached.expiry) {
    return cached.result
  }

  try {
    const webConfig = settings.apis?.web || {}
    const webUrl = webConfig.url || 'http://127.0.0.1:3000'
    const authUser = webConfig.user || 'overleaf'
    const authPass = webConfig.pass || ''

    const url = `${webUrl}/internal/project/${projectId}/membership/${userId}`
    const headers = {}
    if (authPass) {
      headers.Authorization = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(settings.projectAccess?.requestTimeoutMs || 5000),
    })

    const result = response.ok
    try { await response.body?.cancel() } catch {}
    _projectAccessCache.set(cacheKey, { result, expiry: Date.now() + PROJECT_ACCESS_CACHE_TTL })

    _cleanupCache()

    return result
  } catch {
    return false
  }
}

/**
 * Verify the user has write access to the project via Web internal API.
 * Uses the /internal/project/:id/write-membership endpoint that checks
 * canUserWriteProjectContent.
 * Returns true if authorized, false otherwise.
 */
export async function checkProjectWriteAccess(projectId, userId) {
  // Validate format to prevent path traversal / SSRF
  if (!PROJECT_ID_RE.test(projectId) || !USER_ID_RE.test(userId)) {
    return false
  }

  const cacheKey = `write:${userId}:${projectId}`
  const cached = _projectAccessCache.get(cacheKey)
  if (cached && Date.now() < cached.expiry) {
    return cached.result
  }

  try {
    const webConfig = settings.apis?.web || {}
    const webUrl = webConfig.url || 'http://127.0.0.1:3000'
    const authUser = webConfig.user || 'overleaf'
    const authPass = webConfig.pass || ''

    const url = `${webUrl}/internal/project/${projectId}/write-membership/${userId}`
    const headers = {}
    if (authPass) {
      headers.Authorization = `Basic ${Buffer.from(`${authUser}:${authPass}`).toString('base64')}`
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(settings.projectAccess?.requestTimeoutMs || 5000),
    })

    const result = response.ok
    try { await response.body?.cancel() } catch {}
    _projectAccessCache.set(cacheKey, { result, expiry: Date.now() + PROJECT_ACCESS_CACHE_TTL })

    _cleanupCache()

    return result
  } catch {
    return false
  }
}

/**
 * Periodic cleanup when cache grows large (shared across read/write checks).
 */
function _cleanupCache() {
  if (_projectAccessCache.size > (settings.projectAccess?.cacheCleanupThreshold || 5000)) {
    const now = Date.now()
    for (const [key, entry] of _projectAccessCache) {
      if (now >= entry.expiry) _projectAccessCache.delete(key)
    }
  }

  if (_projectAccessCache.size > (settings.projectAccess?.cacheForceCleanupThreshold || 20000)) {
    const oldestKey = _projectAccessCache.keys().next().value
    _projectAccessCache.delete(oldestKey)
  }
}

/**
 * Create a simple in-memory rate limiter (per userId, fixed window).
 *
 * @param {object} opts
 * @param {number} opts.windowMs  - Window duration in milliseconds (default 60_000)
 * @param {number} opts.max       - Max requests per window per user (default 60)
 * @returns {function(string): boolean} - Returns true if within limit, false if exceeded
 */
export function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const map = new Map() // userId -> { count, windowStart }

  // Periodic cleanup to prevent memory leaks
  setInterval(() => {
    const cutoff = Date.now() - windowMs
    for (const [key, val] of map) {
      if (val.windowStart < cutoff) map.delete(key)
    }
  }, windowMs).unref()

  return function checkRateLimit(userId) {
    const now = Date.now()
    const entry = map.get(userId)
    if (!entry || now - entry.windowStart >= windowMs) {
      // Cleanup when map grows large (in addition to periodic cleanup)
      if (map.size > (settings.projectAccess?.rateLimitMapCleanupThreshold || 10000)) {
        for (const [id, e] of map) {
          if (now - e.windowStart >= windowMs) map.delete(id)
        }
      }
      map.set(userId, { count: 1, windowStart: now })
      if (map.size > (settings.projectAccess?.rateLimitMapForceCleanupThreshold || 20000)) {
        const oldestKey = map.keys().next().value
        map.delete(oldestKey)
      }
      return true
    }
    if (entry.count >= max) return false
    entry.count++
    return true
  }
}
