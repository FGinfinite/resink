import settings from '@overleaf/settings'

const SECTION_COMMANDS = ['part', 'chapter', 'section', 'subsection', 'subsubsection']
const SECTION_LEVELS = Object.fromEntries(SECTION_COMMANDS.map((cmd, i) => [cmd, i]))
const MAX_ENTRIES = settings.document?.outlineMaxEntries || 30

/**
 * Extract structured outline entries from LaTeX content.
 * Returns array of { level, command, title, startLine, endLine, lineCount }, or null if no sections found.
 */
export function extractOutlineEntries(content) {
  const sectionPattern = /^[^%\n]*\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/gm
  const entries = []

  let match
  while ((match = sectionPattern.exec(content)) !== null) {
    entries.push({
      level: SECTION_LEVELS[match[1]],
      command: match[1],
      title: match[2].trim(),
      startLine: content.substring(0, match.index).split('\n').length,
    })
  }

  if (entries.length === 0) return null

  const totalLines = content.split('\n').length

  // Compute endLine for each entry: find next entry at same or higher level
  for (let i = 0; i < entries.length; i++) {
    let endLine = totalLines
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].level <= entries[i].level) {
        endLine = entries[j].startLine - 1
        break
      }
    }
    entries[i].endLine = endLine
    entries[i].lineCount = entries[i].endLine - entries[i].startLine + 1
  }

  return entries
}

/**
 * Format outline entries into a readable string.
 * @param {Array} entries - From extractOutlineEntries()
 * @param {object} [options]
 * @param {number} [options.fromLine] - Only include entries starting at or after this line
 * @returns {string|null}
 */
export function formatOutlineEntries(entries, options = {}) {
  if (!entries || entries.length === 0) return null

  const { fromLine } = options

  let filtered = entries
  if (fromLine != null) {
    // Include entries whose range overlaps with fromLine onwards
    filtered = entries.filter(e => e.endLine >= fromLine)
  }

  if (filtered.length === 0) return null

  const topLevel = Math.min(...filtered.map(e => e.level))

  // Try 2 levels
  let display = filtered.filter(e => e.level <= topLevel + 1)
  if (display.length > MAX_ENTRIES) {
    // Reduce to 1 level
    display = filtered.filter(e => e.level === topLevel)
  }

  let truncated = false
  if (display.length > MAX_ENTRIES) {
    display = display.slice(0, MAX_ENTRIES)
    truncated = true
  }

  const lines = display.map(e => {
    const indent = '  '.repeat(e.level - topLevel)
    return `${indent}\\${e.command}{${e.title}} (L${e.startLine}–L${e.endLine}, ${e.lineCount} lines)`
  })

  if (truncated) {
    const total = filtered.filter(e => e.level === topLevel).length
    lines.push(`(... ${total - MAX_ENTRIES} more)`)
  }

  return lines.join('\n')
}

/**
 * Extract LaTeX sectioning outline from document content.
 * Returns formatted outline string, or null if no sections found.
 *
 * Depth control:
 * - Shows top 2 levels (highest found + next level)
 * - If > MAX_ENTRIES: reduce to 1 level
 * - If still > MAX_ENTRIES: truncate with note
 */
export function extractOutline(content) {
  const entries = extractOutlineEntries(content)
  if (!entries) return null
  return formatOutlineEntries(entries)
}

/**
 * Generate a compact outline for content after a truncation point.
 * Used by read_document to show remaining document structure.
 * @param {string} content - Full document content
 * @param {number} fromLine - 1-based line number to start from
 * @returns {string|null}
 */
export function generateTruncationOutline(content, fromLine) {
  const entries = extractOutlineEntries(content)
  if (!entries) return null

  // Only entries that start at or after fromLine
  const remaining = entries.filter(e => e.startLine >= fromLine)
  if (remaining.length === 0) return null

  const topLevel = Math.min(...remaining.map(e => e.level))

  // Show top 2 levels, max 20 entries
  let display = remaining.filter(e => e.level <= topLevel + 1)
  if (display.length > 20) {
    display = remaining.filter(e => e.level === topLevel)
  }

  let truncated = false
  if (display.length > 20) {
    display = display.slice(0, 20)
    truncated = true
  }

  const lines = display.map(e => {
    const indent = '  '.repeat(e.level - topLevel)
    return `${indent}\\${e.command}{${e.title}} (L${e.startLine}–L${e.endLine})`
  })

  if (truncated) {
    lines.push('(... more sections)')
  }

  return lines.join('\n')
}

/**
 * Extract \input, \include, \bibliography references from document content.
 * Fallback for multi-file projects where main.tex has no sectioning commands.
 * Returns formatted string, or null if none found.
 */
export function extractFileReferences(content) {
  const pattern = /^[^%\n]*\\(input|include|bibliography|addbibresource)\{([^}]+)\}/gm
  const refs = []

  let match
  while ((match = pattern.exec(content)) !== null) {
    refs.push({
      command: match[1],
      path: match[2].trim(),
      line: content.substring(0, match.index).split('\n').length,
    })
  }

  if (refs.length === 0) return null

  return refs.map(r => `\\${r.command}{${r.path}} (L${r.line})`).join('\n')
}
