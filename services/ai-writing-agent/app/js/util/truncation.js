import settings from '@overleaf/settings'

const DEFAULT_MAX_LINES = settings.document?.maxLines || 1000
const DEFAULT_MAX_CHARS = settings.document?.maxChars || 50000
const DEFAULT_MAX_CONTENT_LENGTH = settings.document?.maxContentLength || 100000

const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 }

/**
 * Truncate text to a maximum number of lines
 * @param {string} text - The text to truncate
 * @param {number} maxLines - Maximum number of lines
 * @returns {{ text: string, truncated: boolean, totalLines: number }}
 */
export function truncateByLines(text, maxLines = DEFAULT_MAX_LINES) {
  const lines = text.split('\n')
  const totalLines = lines.length

  if (lines.length <= maxLines) {
    return { text, truncated: false, totalLines }
  }

  const truncatedLines = lines.slice(0, maxLines)
  return {
    text: truncatedLines.join('\n'),
    truncated: true,
    totalLines,
  }
}

/**
 * Truncate text to a maximum length
 * @param {string} text - The text to truncate
 * @param {number} maxLength - Maximum character length
 * @returns {{ text: string, truncated: boolean, totalLength: number }}
 */
export function truncateByLength(text, maxLength = DEFAULT_MAX_CONTENT_LENGTH) {
  const totalLength = text.length

  if (text.length <= maxLength) {
    return { text, truncated: false, totalLength }
  }

  return {
    text: text.slice(0, maxLength),
    truncated: true,
    totalLength,
  }
}

/**
 * Dual truncation: truncate by both line count and character count.
 * Whichever limit is hit first takes effect.
 * @param {string} text - The text to truncate
 * @param {number} maxLines - Maximum number of lines
 * @param {number} maxChars - Maximum number of characters
 * @returns {{ text: string, truncated: boolean, totalLines: number, totalChars: number, truncatedAtLine: number }}
 */
export function truncateByLinesAndChars(text, maxLines = DEFAULT_MAX_LINES, maxChars = DEFAULT_MAX_CHARS) {
  const allLines = text.split('\n')
  const totalLines = allLines.length
  const totalChars = text.length

  if (totalLines <= maxLines && totalChars <= maxChars) {
    return { text, truncated: false, totalLines, totalChars, truncatedAtLine: totalLines }
  }

  // First pass: limit by lines
  const lineSlice = allLines.slice(0, maxLines)

  // Second pass: limit by chars within the line-limited result
  let charCount = 0
  let truncatedAtLine = 0
  const resultLines = []

  for (let i = 0; i < lineSlice.length; i++) {
    const lineLen = lineSlice[i].length + (i > 0 ? 1 : 0) // +1 for newline separator
    if (charCount + lineLen > maxChars && i > 0) {
      break
    }
    resultLines.push(lineSlice[i])
    charCount += lineLen
    truncatedAtLine = i + 1
  }

  const resultText = resultLines.join('\n')
  const truncated = truncatedAtLine < totalLines

  return { text: resultText, truncated, totalLines, totalChars, truncatedAtLine }
}

/**
 * Extract a specific LaTeX section from content (level-aware).
 * Stops only at same-level or higher-level section commands.
 * @param {string} content - The full document content
 * @param {string} sectionName - The section name to extract (e.g., "Introduction")
 * @returns {{ content: string, found: boolean, startLine: number, endLine: number, command: string }}
 */
export function extractLatexSection(content, sectionName) {
  const lines = content.split('\n')

  // Match section commands: \section{Name}, \subsection{Name}, etc.
  const sectionPattern = new RegExp(
    `^\\s*\\\\(section|subsection|subsubsection|chapter|part)\\{${escapeRegex(sectionName)}\\}`,
    'i'
  )

  let startLine = -1
  let matchedCommand = null
  let matchedLevel = -1
  let endLine = lines.length

  for (let i = 0; i < lines.length; i++) {
    const startMatch = sectionPattern.exec(lines[i])
    if (startMatch && startLine === -1) {
      startLine = i
      matchedCommand = startMatch[1]
      matchedLevel = LEVELS[matchedCommand] ?? 99
      continue
    }

    if (startLine !== -1) {
      // Check if this line is a section command at same or higher level
      const nextMatch = /^\s*\\(section|subsection|subsubsection|chapter|part)\{/.exec(lines[i])
      if (nextMatch) {
        const nextLevel = LEVELS[nextMatch[1]] ?? 99
        if (nextLevel <= matchedLevel) {
          endLine = i
          break
        }
      }
    }
  }

  if (startLine === -1) {
    return { content: '', found: false, startLine: -1, endLine: -1, command: '' }
  }

  const sectionContent = lines.slice(startLine, endLine).join('\n')
  return {
    content: sectionContent,
    found: true,
    startLine: startLine + 1, // 1-based
    endLine,
    command: matchedCommand,
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
