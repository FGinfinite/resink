import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { DocumentAdapter } from './adapter/DocumentAdapter.js'
import { ProjectAdapter } from './adapter/ProjectAdapter.js'
import { loadTemplate } from './prompt/system.js'
import { extractOutlineEntries } from './util/outline.js'
import { getModelConfigService } from './ModelConfigService.js'

// Adaptive refresh thresholds
const STAGE_THRESHOLDS = [
  { maxChars: 1000, changeRate: Infinity },  // Too short, don't generate
  { maxChars: 8000, changeRate: 0.40 },      // Draft stage 40%
  { maxChars: 20000, changeRate: 0.25 },     // Early stage 25%
  { maxChars: Infinity, changeRate: 0.15 },  // Mature stage 15%
]

const ABSOLUTE_EXPIRY_MS = settings.autocomplete?.digest?.absoluteExpiryMs || 30 * 60 * 1000  // 30 minutes
const CACHE_MAX_SIZE = settings.autocomplete?.digest?.cacheMaxSize || 100

class DocumentDigestManager {
  constructor() {
    const digestConfig = settings.autocomplete?.digest || {}

    this._llm = null
    this._adapterTs = 0

    this._documentAdapter = new DocumentAdapter()
    this._projectAdapter = new ProjectAdapter()
    this._maxContentChars = digestConfig.maxContentChars || (settings.autocomplete?.digest?.maxContentChars || 30000)
    this._maxTokens = digestConfig.maxTokens || 800

    // Cache: "projectId:fileName" -> { global, sections, outlineEntries, generatedAt, charCountAtGeneration, outlineCount }
    this._cache = new Map()
    // Pending refreshes to prevent concurrent duplicates
    this._pendingRefreshes = new Map()
  }

  async _getAdapter() {
    if (this._llm && Date.now() - this._adapterTs < 60000) {
      return this._llm
    }
    try {
      const resolved = await getModelConfigService().resolveFeatureSlot('digestModel')
      this._llm = resolved.adapter
    } catch {
      this._llm = null  // digest feature degrades: skip digest generation
    }
    this._adapterTs = Date.now()
    return this._llm
  }

  /**
   * Get or refresh document digest.
   * - No cache: synchronously wait for generation (up to timeout)
   * - Cached but expired: return old cache, refresh in background (stale-while-revalidate)
   * - Cached and fresh: return directly
   */
  async getOrRefresh(projectId, fileName, currentCharCount, signal) {
    // Too short, don't generate digest
    if (currentCharCount < (settings.autocomplete?.digest?.minDocumentChars || 1000)) return null

    const cacheKey = `${projectId}:${fileName}`
    const cached = this._cache.get(cacheKey)

    if (cached) {
      const needsRefresh = this._needsRefresh(cached, currentCharCount)
      if (!needsRefresh) {
        // LRU touch
        this._cache.delete(cacheKey)
        this._cache.set(cacheKey, cached)
        return cached
      }
      // Stale-while-revalidate: return old, refresh in background
      this._backgroundRefresh(projectId, fileName, cacheKey, currentCharCount)
      return cached
    }

    // First request: deduplicate concurrent calls for same document
    const pending = this._pendingRefreshes.get(cacheKey)
    if (pending) {
      try {
        return await pending.promise
      } catch {
        return null
      }
    }
    const promise = this._generateDigest(projectId, fileName, cacheKey, currentCharCount, signal)
      .catch(err => {
        logger.debug({ err, projectId, fileName }, 'digest generation failed')
        return null
      })
      .finally(() => {
        this._pendingRefreshes.delete(cacheKey)
      })
    this._pendingRefreshes.set(cacheKey, { promise })
    return await promise
  }

  /**
   * Locate cursor's section, return position and context
   */
  locateCursorContext(digest, cursorLine) {
    if (!digest || !digest.outlineEntries || digest.outlineEntries.length === 0) {
      return { position: null, context: digest?.global ? { global: digest.global } : null }
    }

    // Find the last entry with startLine <= cursorLine
    let currentEntry = null
    let currentIndex = -1
    for (let i = 0; i < digest.outlineEntries.length; i++) {
      if (digest.outlineEntries[i].startLine <= cursorLine) {
        currentEntry = digest.outlineEntries[i]
        currentIndex = i
      } else {
        break
      }
    }

    if (!currentEntry) {
      return { position: null, context: digest.global ? { global: digest.global } : null }
    }

    const position = `\\${currentEntry.command}{${currentEntry.title}}`

    const context = {}
    if (digest.global) {
      context.global = digest.global
    }

    // current section description
    if (digest.sections && digest.sections[currentEntry.title]) {
      context.current_section = digest.sections[currentEntry.title]
    }

    // adjacent sections (previous + next in outline order)
    const adjacent = {}
    // Previous
    if (currentIndex > 0) {
      const prev = digest.outlineEntries[currentIndex - 1]
      if (digest.sections && digest.sections[prev.title]) {
        adjacent[prev.title] = digest.sections[prev.title]
      }
    }
    // Next
    if (currentIndex < digest.outlineEntries.length - 1) {
      const next = digest.outlineEntries[currentIndex + 1]
      if (digest.sections && digest.sections[next.title]) {
        adjacent[next.title] = digest.sections[next.title]
      }
    }
    if (Object.keys(adjacent).length > 0) {
      context.adjacent = adjacent
    }

    return { position, context: Object.keys(context).length > 0 ? context : null }
  }

  _needsRefresh(cached, currentCharCount) {
    const now = Date.now()

    // Absolute expiry
    if (now - cached.generatedAt > ABSOLUTE_EXPIRY_MS) return true

    // Character change rate
    const oldCount = cached.charCountAtGeneration
    if (oldCount === 0) return true

    const changeRate = Math.abs(currentCharCount - oldCount) / oldCount

    for (const stage of STAGE_THRESHOLDS) {
      if (oldCount < stage.maxChars) {
        return changeRate >= stage.changeRate
      }
    }
    return false
  }

  _backgroundRefresh(projectId, fileName, cacheKey, currentCharCount) {
    if (this._pendingRefreshes.has(cacheKey)) return

    const abortController = new AbortController()
    const promise = this._generateDigest(projectId, fileName, cacheKey, currentCharCount, abortController.signal)
      .catch(err => {
        logger.debug({ err, projectId, fileName }, 'background digest refresh failed')
      })
      .finally(() => {
        this._pendingRefreshes.delete(cacheKey)
      })

    this._pendingRefreshes.set(cacheKey, { promise, abort: abortController })
  }

  async _generateDigest(projectId, fileName, cacheKey, currentCharCount, signal) {
    // 1. Resolve fileName to docId — prefer exact path match, detect ambiguity
    const entities = await this._projectAdapter.getEntities(projectId)
    const allDocs = entities.docs || []

    // Try exact matches first
    let doc = allDocs.find(d => d.path === `/${fileName}` || d.path === fileName)
    if (!doc) {
      // Fallback to endsWith — but detect ambiguity
      const suffixMatches = allDocs.filter(d => d.path.endsWith(`/${fileName}`))
      if (suffixMatches.length === 1) {
        doc = suffixMatches[0]
      } else if (suffixMatches.length > 1) {
        logger.debug({ projectId, fileName, matches: suffixMatches.length }, 'digest: ambiguous fileName, skipping')
        return null
      }
    }
    if (!doc) return null

    // 2. Get document content
    if (signal?.aborted) return null
    const docData = await this._documentAdapter.getDocumentContent(projectId, doc.id)
    const fullContent = typeof docData?.content === 'string' ? docData.content : ''

    // Server-side content length gate: don't trust client-provided charCount alone
    if (fullContent.length < (settings.autocomplete?.digest?.minDocumentChars || 1000)) return null

    // 3. Extract outline from full content (so cursor beyond maxContentChars can still locate)
    const outlineEntries = extractOutlineEntries(fullContent) || []
    const content = fullContent.slice(0, this._maxContentChars)
    if (outlineEntries.length === 0 && currentCharCount < (settings.autocomplete?.digest?.minOutlineChars || 3000)) {
      // Short document with no outline, not worth generating digest
      return null
    }

    // 4. Build prompt
    if (signal?.aborted) return null
    const systemPrompt = await loadTemplate('autocomplete-digest')

    const outlineStr = outlineEntries.length > 0
      ? outlineEntries.map(e => `\\${e.command}{${e.title}} (L${e.startLine})`).join('\n')
      : '(no sectioning commands found)'

    const userContent = `Document outline:\n${outlineStr}\n\n---\n\nDocument content:\n${content}`

    // 5. Call LLM
    if (signal?.aborted) return null
    logger.debug({ projectId, fileName }, 'generating document digest')

    const adapter = await this._getAdapter()
    if (!adapter) return null
    const result = await adapter.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      maxTokens: this._maxTokens,
      signal,
    })

    // 6. Parse response
    let parsed
    try {
      // Strip markdown code fences if present
      let raw = result.content.trim()
      if (raw.startsWith('```')) {
        const first = raw.indexOf('\n')
        const last = raw.lastIndexOf('```')
        if (first !== -1 && last > first) {
          raw = raw.slice(first + 1, last).trim()
        }
      }
      parsed = JSON.parse(raw)
    } catch {
      logger.debug({ projectId, fileName, rawLength: result.content?.length ?? 0 }, 'digest parse failed')
      return null
    }

    // 7. Sanitize and build cache entry
    const safeGlobal = typeof parsed.global === 'string'
      ? parsed.global.trim().slice(0, settings.autocomplete?.digest?.globalSummaryMaxChars || 2000)
      : null
    const safeSections = Object.create(null)
    if (parsed.sections && typeof parsed.sections === 'object' && !Array.isArray(parsed.sections)) {
      for (const [title, desc] of Object.entries(parsed.sections)) {
        if (typeof title !== 'string' || typeof desc !== 'string') continue
        const key = title.trim().slice(0, settings.autocomplete?.digest?.sectionTitleMaxLength || 200)
        const value = desc.trim().slice(0, settings.autocomplete?.digest?.sectionDescMaxLength || 1000)
        if (!key || !value) continue
        safeSections[key] = value
      }
    }

    const entry = {
      global: safeGlobal,
      sections: safeSections,
      outlineEntries,
      generatedAt: Date.now(),
      charCountAtGeneration: currentCharCount,
      outlineCount: outlineEntries.length,
    }

    // 8. Store in cache with LRU eviction
    if (this._cache.size >= CACHE_MAX_SIZE) {
      const oldestKey = this._cache.keys().next().value
      this._cache.delete(oldestKey)
    }
    this._cache.set(cacheKey, entry)

    return entry
  }
}

// Singleton instance
const digestManager = new DocumentDigestManager()
export default digestManager
