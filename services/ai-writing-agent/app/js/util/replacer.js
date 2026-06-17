import settings from '@overleaf/settings'

/**
 * Error thrown when replacer chain cannot find a unique match.
 * Intentionally does NOT import from DocumentAdapter to avoid circular dependencies.
 */
export class ReplacerMatchError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'ReplacerMatchError'
    this.info = info
  }
}

/**
 * Levenshtein distance between two strings.
 * For long strings, uses a two-row optimization.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const lenA = a.length
  const lenB = b.length

  if (lenA === 0) return lenB
  if (lenB === 0) return lenA

  // Two-row optimization
  let prev = new Array(lenB + 1)
  let curr = new Array(lenB + 1)

  for (let j = 0; j <= lenB; j++) {
    prev[j] = j
  }

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      )
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[lenB]
}

/**
 * Calculate similarity between two strings (0-1).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0

  // Skip expensive Levenshtein for very long strings
  const MAX_LEVENSHTEIN_LEN = settings.replacer?.maxLevenshteinLength || 5000
  if (a.length > MAX_LEVENSHTEIN_LEN || b.length > MAX_LEVENSHTEIN_LEN) {
    // Fallback to simple length ratio check
    const shorter = Math.min(a.length, b.length)
    const longer = Math.max(a.length, b.length)
    return shorter / longer
  }

  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

// ─── Replacer generators ────────────────────────────────────────────────────

/**
 * SimpleReplacer: exact match (baseline).
 * Yields oldString as-is if found in content.
 */
function* SimpleReplacer(content, find) {
  if (content.includes(find)) {
    yield find
  }
}

/**
 * LineTrimmedReplacer: match by trimming each line of find and content.
 * Handles leading/trailing whitespace differences on individual lines.
 */
function* LineTrimmedReplacer(content, find) {
  const findLines = find.split('\n')
  const contentLines = content.split('\n')

  if (findLines.length === 0) return

  const trimmedFindLines = findLines.map(l => l.trim())

  // Slide a window of findLines.length over contentLines
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    let match = true
    for (let j = 0; j < findLines.length; j++) {
      if (contentLines[i + j].trim() !== trimmedFindLines[j]) {
        match = false
        break
      }
    }

    if (match) {
      // Yield the actual content lines (with original whitespace)
      const matchedLines = contentLines.slice(i, i + findLines.length)
      yield matchedLines.join('\n')
    }
  }
}

/**
 * BlockAnchorReplacer: match using first and last lines as anchors,
 * then verify the middle lines are similar via Levenshtein.
 * Requires >= 3 lines in find.
 */
function* BlockAnchorReplacer(content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) return

  const contentLines = content.split('\n')
  const firstTrimmed = findLines[0].trim()
  const lastTrimmed = findLines[findLines.length - 1].trim()

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    if (contentLines[i].trim() !== firstTrimmed) continue
    if (contentLines[i + findLines.length - 1].trim() !== lastTrimmed) continue

    // First and last anchors match — check middle similarity
    const candidateLines = contentLines.slice(i, i + findLines.length)
    const candidateMiddle = candidateLines.slice(1, -1).join('\n')
    const findMiddle = findLines.slice(1, -1).join('\n')

    const sim = similarity(findMiddle, candidateMiddle)
    if (sim > 0.8) {
      yield candidateLines.join('\n')
    }
  }
}

/**
 * WhitespaceNormalizedReplacer: collapse all whitespace runs into single spaces
 * and compare, then yield the original content substring.
 */
function* WhitespaceNormalizedReplacer(content, find) {
  const normFind = find.replace(/\s+/g, ' ').trim()
  if (!normFind) return

  // Build normalized content preserving line boundaries for reconstruction
  // We search in a normalized version of the full content
  const normContent = content.replace(/\s+/g, ' ').trim()

  // Find all normalized match positions to detect ambiguity
  const normMatches = []
  let searchStart = 0
  while (true) {
    const idx = normContent.indexOf(normFind, searchStart)
    if (idx === -1) break
    normMatches.push(idx)
    searchStart = idx + 1
  }

  if (normMatches.length === 0) return
  if (normMatches.length > 1) return // multiple matches, ambiguous

  const normIdx = normMatches[0]

  // Map back from normalized position to original content
  // Walk through content tracking normalized position
  let normPos = 0
  let origStart = -1
  let origEnd = -1
  let inWhitespace = false

  // Skip leading whitespace in content (matches the .trim())
  let origIdx = 0
  while (origIdx < content.length && /\s/.test(content[origIdx])) {
    origIdx++
  }

  for (; origIdx < content.length && origEnd === -1; origIdx++) {
    if (normPos === normIdx && origStart === -1 && !/\s/.test(content[origIdx])) {
      origStart = origIdx
    }

    if (/\s/.test(content[origIdx])) {
      if (!inWhitespace) {
        normPos++ // one space for the whitespace run
        inWhitespace = true
      }
    } else {
      inWhitespace = false
      normPos++
    }

    if (normPos === normIdx + normFind.length && origEnd === -1) {
      origEnd = origIdx + 1
    }
  }

  // Handle case where match extends to end of content
  if (origStart !== -1 && origEnd === -1 && normPos === normIdx + normFind.length) {
    origEnd = content.length
  }

  if (origStart !== -1 && origEnd !== -1) {
    yield content.slice(origStart, origEnd)
  }
}

/**
 * IndentationFlexibleReplacer: remove common leading indentation from both
 * find and content blocks, then compare.
 */
function* IndentationFlexibleReplacer(content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 2) return

  const contentLines = content.split('\n')

  // Compute the minimum indentation of non-empty find lines
  const findIndent = minIndent(findLines)

  // Dedented find lines
  const dedentedFind = findLines.map(l =>
    l.length > 0 ? l.slice(Math.min(findIndent, leadingSpaces(l))) : l
  )

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const candidateLines = contentLines.slice(i, i + findLines.length)
    const candidateIndent = minIndent(candidateLines)
    const dedentedCandidate = candidateLines.map(l =>
      l.length > 0 ? l.slice(Math.min(candidateIndent, leadingSpaces(l))) : l
    )

    // Compare dedented versions
    let match = true
    for (let j = 0; j < findLines.length; j++) {
      if (dedentedCandidate[j] !== dedentedFind[j]) {
        match = false
        break
      }
    }

    if (match) {
      yield candidateLines.join('\n')
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function leadingSpaces(line) {
  const match = line.match(/^(\s*)/)
  return match ? match[1].length : 0
}

function minIndent(lines) {
  let min = Infinity
  for (const line of lines) {
    if (line.trim().length === 0) continue // skip empty lines
    const spaces = leadingSpaces(line)
    if (spaces < min) min = spaces
  }
  return min === Infinity ? 0 : min
}

// ─── Ordered replacer chain ─────────────────────────────────────────────────

const REPLACERS = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
]

// ─── Large-content guard thresholds ─────────────────────────────────────────

const MAX_REPLACER_CONTENT_CHARS = 200_000
const MAX_REPLACER_OLDSTRING_CHARS = 20_000

/**
 * Find a unique match for `oldString` in `content` using the replacer chain.
 * Returns { position, matchedText } on success.
 * Throws EditMatchError on failure.
 *
 * @param {string} content - Full document content
 * @param {string} oldString - Text the AI wants to replace
 * @returns {{ position: { start: number, end: number }, matchedText: string }}
 */
export function findMatch(content, oldString) {
  if (!oldString || !oldString.trim()) {
    throw new ReplacerMatchError(
      'oldText must not be empty or whitespace-only',
      { oldText: oldString }
    )
  }
  // Guard: skip expensive fuzzy replacers for very large inputs
  if (content.length > MAX_REPLACER_CONTENT_CHARS || oldString.length > MAX_REPLACER_OLDSTRING_CHARS) {
    const index = content.indexOf(oldString)
    if (index === -1) {
      const preview = oldString.length > 80 ? oldString.slice(0, 80) + '...' : oldString
      throw new ReplacerMatchError(
        `oldText not found in document (exact match only — content or oldString too large for fuzzy matching): "${preview}"`,
        { oldText: preview }
      )
    }
    const lastIndex = content.lastIndexOf(oldString)
    if (index !== lastIndex) {
      throw new ReplacerMatchError(
        'oldText matches multiple locations in the document. ' +
          'Include more surrounding context to make it unique, or use replaceAll to replace every occurrence.',
        { multipleMatches: true }
      )
    }
    return {
      position: { start: index, end: index + oldString.length },
      matchedText: oldString,
    }
  }

  let notFound = true

  for (const replacer of REPLACERS) {
    for (const candidate of replacer(content, oldString)) {
      const index = content.indexOf(candidate)
      if (index === -1) continue

      notFound = false

      const lastIndex = content.lastIndexOf(candidate)
      if (index !== lastIndex) {
        // Multiple matches with this replacer — try the next one
        continue
      }

      // Unique match found
      return {
        position: { start: index, end: index + candidate.length },
        matchedText: candidate,
      }
    }
  }

  if (notFound) {
    const preview = oldString.length > 80 ? oldString.slice(0, 80) + '...' : oldString
    throw new ReplacerMatchError(
      `oldText not found in document: "${preview}"`,
      { oldText: preview }
    )
  }

  throw new ReplacerMatchError(
    'oldText matches multiple locations in the document. ' +
      'Include more surrounding context to make it unique, or use replaceAll to replace every occurrence.',
    { multipleMatches: true }
  )
}

/**
 * Replace oldString with newString in content.
 * When replaceAll is true, replaces all occurrences (using the first successful replacer).
 * When replaceAll is false, requires a unique match.
 *
 * @param {string} content
 * @param {string} oldString
 * @param {string} newString
 * @param {boolean} replaceAll
 * @returns {{ newContent: string, position?: { start: number, end: number }, matchedText: string }}
 */
export function replace(content, oldString, newString, replaceAll = false) {
  if (!oldString || !oldString.trim()) {
    throw new ReplacerMatchError(
      'oldText must not be empty or whitespace-only',
      { oldText: oldString }
    )
  }
  // Guard: skip expensive fuzzy replacers for very large inputs
  if (content.length > MAX_REPLACER_CONTENT_CHARS || oldString.length > MAX_REPLACER_OLDSTRING_CHARS) {
    const index = content.indexOf(oldString)
    if (index === -1) {
      const preview = oldString.length > 80 ? oldString.slice(0, 80) + '...' : oldString
      throw new ReplacerMatchError(
        `oldText not found in document (exact match only — content or oldString too large for fuzzy matching): "${preview}"`,
        { oldText: preview }
      )
    }
    if (replaceAll) {
      const newContent = content.split(oldString).join(newString)
      return { newContent, matchedText: oldString }
    }
    const lastIndex = content.lastIndexOf(oldString)
    if (index !== lastIndex) {
      throw new ReplacerMatchError(
        'oldText matches multiple locations in the document. ' +
          'Include more surrounding context to make it unique, or use replaceAll to replace every occurrence.',
        { multipleMatches: true }
      )
    }
    const newContent =
      content.slice(0, index) + newString + content.slice(index + oldString.length)
    return {
      newContent,
      position: { start: index, end: index + oldString.length },
      matchedText: oldString,
    }
  }

  if (replaceAll) {
    // For replaceAll, find the first replacer that produces a candidate present in content
    let notFound = true

    for (const replacer of REPLACERS) {
      for (const candidate of replacer(content, oldString)) {
        const index = content.indexOf(candidate)
        if (index === -1) continue

        notFound = false

        // Replace all occurrences of this candidate
        const newContent = content.split(candidate).join(newString)
        return {
          newContent,
          matchedText: candidate,
        }
      }
    }

    if (notFound) {
      const preview = oldString.length > 80 ? oldString.slice(0, 80) + '...' : oldString
      throw new ReplacerMatchError(
        `oldText not found in document: "${preview}"`,
        { oldText: preview }
      )
    }

    // Shouldn't reach here since we accept multiple matches in replaceAll mode
    const preview = oldString.length > 80 ? oldString.slice(0, 80) + '...' : oldString
    throw new ReplacerMatchError(
      `oldText not found in document: "${preview}"`,
      { oldText: preview }
    )
  }

  // Single replacement — use findMatch which enforces uniqueness
  const { position, matchedText } = findMatch(content, oldString)
  const newContent =
    content.slice(0, position.start) +
    newString +
    content.slice(position.end)

  return { newContent, position, matchedText }
}
