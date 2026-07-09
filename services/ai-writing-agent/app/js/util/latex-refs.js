/**
 * LaTeX reference, citation, and bibliography scanning utilities.
 * Pure regex-based, no external dependencies.
 */

/**
 * Build an index of line start offsets for O(log n) line number lookups.
 * @param {string} content
 * @returns {number[]}
 */
function buildLineIndex(content) {
  const lineStarts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineStarts.push(i + 1)
    }
  }
  return lineStarts
}

/**
 * Get the 1-based line number for a character offset using binary search.
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {number}
 */
function lineAtOffset(lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * Pre-compute all verbatim environment and \verb command zones as [start, end] intervals.
 * Returns a sorted array of zones suitable for binary search with isInZone().
 * @param {string} content
 * @returns {Array<[number, number]>}
 */
export function buildExclusionZones(content) {
  const zones = []

  // \verb (including \verb* variant) with arbitrary delimiter — cannot cross lines
  const verbRe = /\\verb\*?([^a-zA-Z\s])([^\n]*?)\1/g
  let m
  while ((m = verbRe.exec(content)) !== null) {
    if (isCommented(content, m.index)) continue
    zones.push([m.index, m.index + m[0].length])
  }

  // Verbatim-like environments
  const envNames = 'verbatim|lstlisting|minted|Verbatim'
  const envRe = new RegExp(`\\\\begin\\{(${envNames})\\*?\\}([\\s\\S]*?)\\\\end\\{\\1\\*?\\}`, 'g')
  while ((m = envRe.exec(content)) !== null) {
    if (isCommented(content, m.index)) continue
    zones.push([m.index, m.index + m[0].length])
  }

  // Sort by start offset for binary search
  zones.sort((a, b) => a[0] - b[0])
  return zones
}

/**
 * Check if a given index falls inside any of the pre-computed exclusion zones
 * using binary search.
 * @param {Array<[number, number]>} zones - Sorted array of [start, end] intervals
 * @param {number} index
 * @returns {boolean}
 */
export function isInZone(zones, index) {
  let lo = 0
  let hi = zones.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = zones[mid]
    if (index < start) {
      hi = mid - 1
    } else if (index >= end) {
      lo = mid + 1
    } else {
      return true
    }
  }
  return false
}

/**
 * Check if a match position is inside a LaTeX comment.
 * Handles escaped percent signs (\%) correctly — only an unescaped %
 * before the match position on the same line counts as a comment.
 * @param {string} content
 * @param {number} index - Match start index
 * @returns {boolean}
 */
export function isCommented(content, index) {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1
  const prefix = content.substring(lineStart, index)
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === '%') {
      // Count preceding backslashes to detect \%
      let backslashes = 0
      for (let j = i - 1; j >= 0 && prefix[j] === '\\'; j--) {
        backslashes++
      }
      // Unescaped % if even number of preceding backslashes
      if (backslashes % 2 === 0) return true
    }
  }
  return false
}

/**
 * Extract \label{...} definitions from LaTeX content.
 * Excludes commented-out lines and verbatim environments.
 * @param {string} content - LaTeX source
 * @param {string} filePath - File path for reference
 * @returns {Array<{ key: string, file: string, line: number }>}
 */
export function extractLabels(content, filePath) {
  const pattern = /\\label\s*\{([^}]+)\}/g
  const results = []
  const lineIndex = buildLineIndex(content)
  const zones = buildExclusionZones(content)

  let match
  while ((match = pattern.exec(content)) !== null) {
    if (isCommented(content, match.index)) continue
    if (isInZone(zones, match.index)) continue
    results.push({
      key: match[1],
      file: filePath,
      line: lineAtOffset(lineIndex, match.index),
    })
  }

  return results
}

/**
 * Extract \ref-family commands from LaTeX content.
 * Matches: \ref, \eqref, \autoref, \cref, \Cref, \pageref
 * Handles comma-separated multiple keys for \cref and \Cref.
 * Tolerates whitespace between command and opening brace.
 * Excludes commented-out lines and verbatim environments.
 * @param {string} content - LaTeX source
 * @param {string} filePath - File path for reference
 * @returns {Array<{ key: string, command: string, file: string, line: number }>}
 */
export function extractRefs(content, filePath) {
  const pattern = /\\(ref|eqref|autoref|cref|Cref|pageref)\s*\{([^}]+)\}/g
  const results = []
  const lineIndex = buildLineIndex(content)
  const zones = buildExclusionZones(content)

  let match
  while ((match = pattern.exec(content)) !== null) {
    if (isCommented(content, match.index)) continue
    if (isInZone(zones, match.index)) continue
    const command = match[1]
    const raw = match[2]
    const line = lineAtOffset(lineIndex, match.index)

    // cref/Cref support comma-separated multiple keys
    if (command === 'cref' || command === 'Cref') {
      const keys = raw.split(',').map(k => k.trim()).filter(Boolean)
      for (const key of keys) {
        results.push({
          key,
          command,
          file: filePath,
          line,
        })
      }
    } else {
      results.push({
        key: raw.trim(),
        command,
        file: filePath,
        line,
      })
    }
  }

  return results
}

/**
 * Extract citation commands from LaTeX content.
 * Matches: \cite, \citep, \citet, \citealp, \citealt, \citeauthor, \citeyear,
 *          \parencite, \textcite, \autocite (and starred variants like \cite*).
 * Handles optional arguments: \citep[see][p.3]{key}
 * Handles comma-separated multiple keys: \cite{key1,key2,key3}
 * Tolerates whitespace between command and opening brace/bracket.
 * Excludes commented-out lines and verbatim environments.
 * @param {string} content - LaTeX source
 * @param {string} filePath - File path for reference
 * @returns {Array<{ keys: string[], command: string, file: string, line: number }>}
 */
export function extractCitations(content, filePath) {
  const pattern = /\\((?:no|full|foot|super)?cite[a-z]*|parencite|textcite|autocite)\*?(?:\s*\[[^\]]*\])*\s*\{([^}]+)\}/g
  const results = []
  const lineIndex = buildLineIndex(content)
  const zones = buildExclusionZones(content)

  let match
  while ((match = pattern.exec(content)) !== null) {
    if (isCommented(content, match.index)) continue
    if (isInZone(zones, match.index)) continue
    const keys = match[2].split(',').map(k => k.trim()).filter(Boolean)
    results.push({
      keys,
      command: match[1],
      file: filePath,
      line: lineAtOffset(lineIndex, match.index),
    })
  }

  return results
}

/**
 * Extract bibliography resource commands from LaTeX content.
 * Matches: \bibliography{...} and \addbibresource[...]{...}
 * Tolerates whitespace between command and opening brace/bracket.
 * Excludes commented-out lines and verbatim environments.
 * @param {string} content - LaTeX source
 * @param {string} filePath - File path for reference
 * @returns {Array<{ path: string, command: string, file: string, line: number }>}
 */
export function extractBibResources(content, filePath) {
  const pattern = /\\(bibliography|addbibresource)(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g
  const results = []
  const lineIndex = buildLineIndex(content)
  const zones = buildExclusionZones(content)

  let match
  while ((match = pattern.exec(content)) !== null) {
    if (isCommented(content, match.index)) continue
    if (isInZone(zones, match.index)) continue
    results.push({
      path: match[2].trim(),
      command: match[1],
      file: filePath,
      line: lineAtOffset(lineIndex, match.index),
    })
  }

  return results
}
