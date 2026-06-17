import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import OError from '@overleaf/o-error'
import crypto from 'node:crypto'
import { findMatch, ReplacerMatchError } from '../util/replacer.js'

const DOC_UPDATER_SECRET = settings.apis?.documentUpdater?.secret || ''

const MAX_CONTENT_CACHE_SIZE = settings.document?.contentCacheSize || 50

function _authHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DOC_UPDATER_SECRET) {
    headers['Authorization'] = `Bearer ${DOC_UPDATER_SECRET}`
  }
  return headers
}

export class DocumentError extends OError {}
export class DocumentNotFoundError extends DocumentError {}
export class EditMatchError extends DocumentError {}
export class VersionConflictError extends DocumentError {}
export class RebaseConflictError extends DocumentError {}
export class ApplyEditError extends DocumentError {}

export class DocumentAdapter {
  constructor(options = {}) {
    const apiConfig = settings.apis || {}
    this.documentUpdaterUrl =
      options.documentUpdaterUrl || apiConfig.documentUpdater?.url || 'http://127.0.0.1:3003'
    this.webServiceUrl =
      options.webServiceUrl || apiConfig.web?.url || 'http://127.0.0.1:3000'
    this.timeout = options.timeout || settings.documentEdit?.apiTimeoutMs || 30000
    /** @type {Map<string, string>} */
    this._contentCache = new Map()
  }

  /**
   * Get document content from Document-Updater
   * @param {string} projectId - Project ID
   * @param {string} docId - Document ID
   * @returns {Promise<{ lines: string[], version: number, ranges: object }>}
   */
  async getDocument(projectId, docId) {
    const url = `${this.documentUpdaterUrl}/project/${projectId}/doc/${docId}`

    logger.debug({ projectId, docId, url }, 'Getting document')

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { ..._authHeaders(), Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new DocumentNotFoundError('Document not found', {
            projectId,
            docId,
          })
        }
        const errorText = await response.text()
        logger.warn(
          { status: response.status, projectId, docId, errorText: errorText.slice(0, 500) },
          'DocumentUpdater getDocument failed'
        )
        throw new DocumentError('Failed to get document', {
          status: response.status,
        })
      }

      const data = await response.json()

      return {
        lines: data.lines || [],
        version: data.version || 0,
        ranges: data.ranges || {},
      }
    } catch (error) {
      if (error instanceof DocumentError) {
        throw error
      }
      throw new DocumentError('Failed to get document', { cause: error })
    }
  }

  /**
   * Get document content as a single string
   * @param {string} projectId - Project ID
   * @param {string} docId - Document ID
   * @returns {Promise<{ content: string, version: number }>}
   */
  async getDocumentContent(projectId, docId) {
    const doc = await this.getDocument(projectId, docId)
    const cacheKey = `${projectId}:${docId}:${doc.version}`

    const cached = this._contentCache.get(cacheKey)
    if (cached !== undefined) {
      return { content: cached, version: doc.version }
    }

    const content = doc.lines.join('\n')

    // Evict oldest entries if cache is at capacity
    if (this._contentCache.size >= MAX_CONTENT_CACHE_SIZE) {
      const firstKey = this._contentCache.keys().next().value
      this._contentCache.delete(firstKey)
    }
    this._contentCache.set(cacheKey, content)

    return { content, version: doc.version }
  }

  /**
   * Preview an edit (generate Pending Change without applying)
   * Uses the replacer chain for fuzzy matching with uniqueness enforcement.
   * @param {string} projectId - Project ID
   * @param {string} docId - Document ID
   * @param {string} oldText - Text to replace
   * @param {string} newText - Replacement text
   * @returns {Promise<PendingChange>}
   */
  async previewEdit(projectId, docId, oldText, newText) {
    // Get current document content
    const { content, version } = await this.getDocumentContent(projectId, docId)

    // findMatch uses the replacer chain and enforces uniqueness
    // Throws ReplacerMatchError if not found or multiple matches
    let position, matchedText
    try {
      ;({ position, matchedText } = findMatch(content, oldText))
    } catch (error) {
      if (error instanceof ReplacerMatchError) {
        throw new EditMatchError(error.message, {
          projectId,
          docId,
          ...error.info,
        })
      }
      throw error
    }

    // Generate change ID
    const changeId = this._generateId()

    // Context anchors for rebase validation
    const ANCHOR_LEN = settings.documentEdit?.anchorLength || 100
    const contextBefore = content.slice(Math.max(0, position.start - ANCHOR_LEN), position.start)
    const contextAfter = content.slice(position.end, position.end + ANCHOR_LEN)
    const contextHash = this._hashContext(contextBefore, contextAfter)

    return {
      id: changeId,
      projectId,
      docId,
      baseVersion: version,
      position,
      oldText: matchedText, // Use the actual matched text (may differ in whitespace)
      newText,
      contextHash,
      status: 'pending',
      createdAt: Date.now(),
    }
  }

  /**
   * Build OT operations from a text replacement
   * @param {{ start: number, end: number }} position - Position of text to replace
   * @param {string} oldText - Original text
   * @param {string} newText - Replacement text
   * @returns {Array} - OT operations
   */
  buildOTOps(position, oldText, newText) {
    const ops = []

    // Retain up to the start position
    if (position.start > 0) {
      ops.push({ p: position.start, r: position.start })
    }

    // Delete old text
    if (oldText.length > 0) {
      ops.push({ p: position.start, d: oldText })
    }

    // Insert new text
    if (newText.length > 0) {
      ops.push({ p: position.start, i: newText })
    }

    return ops
  }

  /**
   * Calculate line/column from character position
   * @param {string} content - Document content
   * @param {number} position - Character position
   * @returns {{ line: number, column: number }}
   */
  positionToLineColumn(content, position) {
    const before = content.slice(0, position)
    const lines = before.split('\n')
    return {
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
    }
  }

  /**
   * Calculate character position from line/column
   * @param {string} content - Document content
   * @param {number} line - Line number (1-based)
   * @param {number} column - Column number (1-based)
   * @returns {number}
   */
  lineColumnToPosition(content, line, column) {
    const lines = content.split('\n')
    let position = 0

    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      position += lines[i].length + 1 // +1 for newline
    }

    position += column - 1
    return position
  }

  /**
   * Get project files list from Web service
   * @param {string} projectId - Project ID
   * @returns {Promise<Array>}
   */
  async getProjectFiles(projectId) {
    const url = `${this.webServiceUrl}/project/${projectId}/entities`

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeout),
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.warn(
          { status: response.status, projectId, errorText: errorText.slice(0, 500) },
          'Web getProjectFiles failed'
        )
        throw new DocumentError('Failed to get project files', {
          status: response.status,
        })
      }

      return response.json()
    } catch (error) {
      if (error instanceof DocumentError) {
        throw error
      }
      throw new DocumentError('Failed to get project files', { cause: error })
    }
  }

  /**
   * Apply a pending change to the document
   * @param {object} change - The pending change to apply
   * @param {object} options - { userId: string }
   * @returns {Promise<{ success: boolean, newVersion: number, wasRebased: boolean }>}
   */
  async applyEdit(change, options = {}) {
    const { userId } = options

    if (!userId) {
      throw new ApplyEditError('userId is required to apply edits', {
        changeId: change.id,
      })
    }

    const MAX_RETRIES = settings.documentEdit?.maxRetries || 1

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._tryApplyEdit(change, userId)
      } catch (error) {
        if (error instanceof VersionConflictError && error.info?.concurrentModification && attempt < MAX_RETRIES) {
          logger.warn(
            { changeId: change.id, attempt, err: error },
            'Version conflict during applyEdit, retrying'
          )
          continue
        }
        throw error
      }
    }
  }

  /**
   * Internal: attempt to apply a pending change (read doc, resolve, submit)
   * @param {object} change - The pending change to apply
   * @param {string} userId - User ID making the change
   * @returns {Promise<{ success: boolean, newVersion: number, wasRebased: boolean }>}
   */
  async _tryApplyEdit(change, userId) {
    const { projectId, docId, baseVersion } = change

    // Get current document content
    const currentDoc = await this.getDocumentContent(projectId, docId)

    logger.debug(
      { projectId, docId, baseVersion, currentVersion: currentDoc.version },
      'Checking version for applyEdit'
    )

    if (currentDoc.version < baseVersion) {
      throw new VersionConflictError(
        'Current version is older than base version',
        {
          changeId: change.id,
          baseVersion,
          currentVersion: currentDoc.version,
        }
      )
    }

    // Resolve position against current document content
    const resolution = this._resolveChangePosition(change, currentDoc)

    if (!resolution.success) {
      throw new RebaseConflictError(
        `Cannot apply edit: ${resolution.conflictType}`,
        {
          changeId: change.id,
          conflictType: resolution.conflictType,
          detail: resolution.detail,
          baseVersion,
          currentVersion: currentDoc.version,
        }
      )
    }

    const effectiveChange = resolution.resolvedChange
    const wasRebased = currentDoc.version !== baseVersion

    if (wasRebased) {
      logger.info(
        { changeId: change.id, method: resolution.method, versionDelta: currentDoc.version - baseVersion },
        'Change rebased successfully'
      )
    }

    // Final safety validation: confirm content at resolved position matches
    if (effectiveChange.position) {
      const currentOldText = currentDoc.content.slice(
        effectiveChange.position.start,
        effectiveChange.position.end
      )

      if (currentOldText !== effectiveChange.oldText) {
        throw new EditMatchError(
          'Document content at position does not match expected text',
          {
            changeId: change.id,
            expected: effectiveChange.oldText.slice(0, 50),
            actual: currentOldText.slice(0, 50),
          }
        )
      }
    }

    // Build new content
    const newContent = effectiveChange.replaceAll
      ? effectiveChange.newContent
      : this._applyChangeToContent(currentDoc.content, effectiveChange)
    const newLines = newContent.split('\n')

    // Call Document-Updater setDoc API with CAS version
    await this._callSetDocAPI(projectId, docId, newLines, userId, currentDoc.version)

    logger.info(
      { projectId, docId, changeId: change.id, wasRebased, method: resolution.method },
      'Edit applied successfully'
    )

    return {
      success: true,
      newVersion: currentDoc.version + 1,
      wasRebased,
    }
  }

  /**
   * Call Document-Updater setDoc API
   * @param {string} projectId - Project ID
   * @param {string} docId - Document ID
   * @param {string[]} lines - New document lines
   * @param {string} userId - User ID making the change
   */
  async _callSetDocAPI(projectId, docId, lines, userId, expectedVersion) {
    const url = `${this.documentUpdaterUrl}/project/${projectId}/doc/${docId}`

    // Invalidate content cache for this document (any version)
    this._invalidateDocCache(projectId, docId)

    logger.debug({ projectId, docId, lineCount: lines.length }, 'Calling setDoc API')

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ..._authHeaders(),
          Accept: 'application/json',
        },
        body: JSON.stringify({
          lines,
          source: { kind: 'ai-agent' },
          user_id: userId,
          expected_version: expectedVersion,
        }),
        signal: AbortSignal.timeout(this.timeout),
      })

      if (!response.ok) {
        if (response.status === 409) {
          let actualVersion
          try {
            const body = await response.json()
            actualVersion = body.actual
          } catch { /* ignore parse errors */ }
          throw new VersionConflictError('Document was modified concurrently', {
            projectId, docId, expectedVersion, actualVersion,
            conflictType: 'VERSION_MISMATCH',
            concurrentModification: true
          })
        }
        if (response.status === 406) {
          throw new ApplyEditError('Document too large', {
            status: 406,
            projectId,
            docId,
          })
        }
        const errorText = await response.text()
        logger.warn(
          { status: response.status, projectId, docId, errorText: errorText.slice(0, 500) },
          'DocumentUpdater setDoc failed'
        )
        throw new ApplyEditError('Failed to set document', {
          status: response.status,
          projectId,
          docId,
        })
      }

      return response.json().catch(() => ({}))
    } catch (error) {
      if (error instanceof ApplyEditError || error instanceof VersionConflictError) {
        throw error
      }
      throw new ApplyEditError('Failed to call setDoc API', {
        cause: error,
        projectId,
        docId,
      })
    }
  }

  /**
   * Resolve a PendingChange's position against the current document content.
   * Uses a three-tier strategy:
   *   1. Fast path — version unchanged, validate original position directly
   *   2. findMatch — full replacer chain with uniqueness enforcement
   *   3. Position-assisted disambiguation — when multiple matches exist
   *
   * @param {object} change - The original pending change
   * @param {object} currentDoc - Current document { content, version }
   * @returns {{ success: boolean, resolvedChange?: object, method?: string, conflictType?: string, detail?: string }}
   */
  _resolveChangePosition(change, currentDoc) {
    const { oldText, position: origPos } = change
    const { content, version } = currentDoc

    // Handle replaceAll changes (position: null) — re-do replacement on current content
    if (change.replaceAll && origPos === null) {
      const occurrences = this._findAllOccurrences(content, oldText)
      if (occurrences.length === 0) {
        return { success: false, conflictType: 'NOT_FOUND', detail: 'replaceAll target not found in current document' }
      }
      const newContent = content.split(oldText).join(change.newText)
      return {
        success: true,
        resolvedChange: { ...change, newContent, baseVersion: version },
        method: 'replaceAll_redo',
      }
    }

    // Fast path: if document hasn't changed, validate position directly
    if (version === change.baseVersion && origPos) {
      const atPosition = content.slice(origPos.start, origPos.end)
      if (atPosition === oldText) {
        return {
          success: true,
          resolvedChange: { ...change },
          method: 'exact_position',
        }
      }
      // Version same but content doesn't match — fall through to full resolution
    }

    // Step 1: Try findMatch (full replacer chain + uniqueness enforcement)
    try {
      const { position, matchedText } = findMatch(content, oldText)

      // Verify context anchors if available (skip for exact_position)
      if (change.contextHash) {
        const ANCHOR_LEN = settings.documentEdit?.anchorLength || 100
        const currentBefore = content.slice(Math.max(0, position.start - ANCHOR_LEN), position.start)
        const currentAfter = content.slice(position.end, position.end + ANCHOR_LEN)
        const currentHash = this._hashContext(currentBefore, currentAfter)
        if (currentHash !== change.contextHash) {
          return { success: false, conflictType: 'CONTEXT_CHANGED', detail: 'Surrounding context has changed significantly' }
        }
      }

      return {
        success: true,
        resolvedChange: {
          ...change,
          position,
          oldText: matchedText,
          baseVersion: version,
        },
        method: 'findMatch_unique',
      }
    } catch (error) {
      if (!(error instanceof ReplacerMatchError)) {
        return { success: false, conflictType: 'INTERNAL_ERROR', detail: error.message }
      }

      if (!error.info?.multipleMatches) {
        // oldText not found at all
        return { success: false, conflictType: 'NOT_FOUND', detail: error.message }
      }

      // Multiple matches — fall through to position-assisted disambiguation
    }

    // Step 2: Multiple matches — use original position as disambiguation hint
    return this._disambiguateByPosition(change, content, version)
  }

  /**
   * When oldText appears multiple times in the current document,
   * use the original position as a hint to pick the correct occurrence.
   * Only accepts if the disambiguation is confident enough.
   *
   * @param {object} change - The original pending change
   * @param {string} content - Current document content
   * @param {number} version - Current document version
   * @returns {{ success: boolean, resolvedChange?: object, method?: string, conflictType?: string, detail?: string }}
   */
  _disambiguateByPosition(change, content, version) {
    const { oldText, position: origPos } = change
    const occurrences = this._findAllOccurrences(content, oldText)

    if (occurrences.length === 0) {
      return { success: false, conflictType: 'NOT_FOUND' }
    }

    if (occurrences.length === 1) {
      return {
        success: true,
        resolvedChange: { ...change, position: occurrences[0], baseVersion: version },
        method: 'single_occurrence',
      }
    }

    // Rank by distance to original position
    const ranked = occurrences
      .map(occ => ({ ...occ, distance: Math.abs(occ.start - origPos.start) }))
      .sort((a, b) => a.distance - b.distance)

    const best = ranked[0]
    const secondBest = ranked[1]

    // Confidence criteria:
    // 1. Best match must be within reasonable range
    // 2. Best match must be clearly closer than second-best
    const MAX_SHIFT = settings.documentEdit?.maxShift || 500
    const DISAMBIGUATION_RATIO = settings.documentEdit?.disambiguationRatio || 2.0

    if (best.distance > MAX_SHIFT) {
      return {
        success: false,
        conflictType: 'AMBIGUOUS_FAR',
        detail: `Closest match is ${best.distance} chars away (limit: ${MAX_SHIFT}). ${occurrences.length} occurrences found.`,
      }
    }

    const isConfident =
      best.distance === 0 ||
      secondBest.distance >= best.distance * DISAMBIGUATION_RATIO

    if (!isConfident) {
      return {
        success: false,
        conflictType: 'AMBIGUOUS_CLOSE',
        detail: `Two matches at distances ${best.distance} and ${secondBest.distance}. Cannot confidently disambiguate.`,
      }
    }

    // Verify context anchors if available
    if (change.contextHash) {
      const ANCHOR_LEN = settings.documentEdit?.anchorLength || 100
      const currentBefore = content.slice(Math.max(0, best.start - ANCHOR_LEN), best.start)
      const currentAfter = content.slice(best.end, best.end + ANCHOR_LEN)
      const currentHash = this._hashContext(currentBefore, currentAfter)
      if (currentHash !== change.contextHash) {
        return { success: false, conflictType: 'CONTEXT_CHANGED', detail: 'Surrounding context has changed significantly' }
      }
    }

    return {
      success: true,
      resolvedChange: {
        ...change,
        position: { start: best.start, end: best.end },
        baseVersion: version,
      },
      method: 'position_disambiguated',
    }
  }

  /**
   * Find all exact occurrences of a string in content.
   * @param {string} content - Document content
   * @param {string} text - Text to find
   * @returns {Array<{ start: number, end: number }>}
   */
  _findAllOccurrences(content, text) {
    const occurrences = []
    let searchFrom = 0
    while (true) {
      const idx = content.indexOf(text, searchFrom)
      if (idx === -1) break
      occurrences.push({ start: idx, end: idx + text.length })
      searchFrom = idx + 1
    }
    return occurrences
  }

  /**
   * Apply change to content string
   * @param {string} content - Original content
   * @param {object} change - Change with position, oldText, newText
   * @returns {string}
   */
  _applyChangeToContent(content, change) {
    const { position, newText } = change
    return (
      content.slice(0, position.start) +
      newText +
      content.slice(position.end)
    )
  }

  _generateId() {
    return crypto.randomBytes(12).toString('hex')
  }

  /**
   * Invalidate all cached content entries for a specific document.
   * @param {string} projectId
   * @param {string} docId
   */
  _invalidateDocCache(projectId, docId) {
    const prefix = `${projectId}:${docId}:`
    for (const key of this._contentCache.keys()) {
      if (key.startsWith(prefix)) {
        this._contentCache.delete(key)
      }
    }
  }

  /**
   * Hash context strings for anchor validation
   * @param {string} before - Text before the edit region
   * @param {string} after - Text after the edit region
   * @returns {string} - Hex hash string
   */
  _hashContext(before, after) {
    return crypto.createHash('sha256')
      .update(before)
      .update('\0')
      .update(after)
      .digest('hex')
      .slice(0, 16)  // 16 hex chars = 64 bits, sufficient for change detection
  }
}

// Singleton instance
let defaultAdapter = null

export function getDocumentAdapter() {
  if (!defaultAdapter) {
    defaultAdapter = new DocumentAdapter()
  }
  return defaultAdapter
}

export default DocumentAdapter
