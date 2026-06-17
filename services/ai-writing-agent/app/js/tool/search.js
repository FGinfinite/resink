import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import settings from '@overleaf/settings'
import { validateProjectPath } from '../util/project-path.js'

const DEFAULT_MAX_RESULTS = settings.search?.maxResults || 50
const DEFAULT_CONTEXT_LINES = settings.search?.defaultContextLines || 2
const MAX_CONTEXT_LINES = settings.search?.maxContextLines || 20
const MAX_PATTERN_LENGTH = settings.search?.maxPatternLength || 500
const DEFAULT_MAX_SCAN_BYTES = settings.search?.maxScanBytes || 2_000_000
const DEFAULT_MAX_FILES = settings.search?.maxFiles || 200
const MAX_FILE_SIZE = settings.search?.maxFileSize || 500_000 // 500KB per file — truncate before processing
const MAX_LINE_LENGTH = settings.search?.maxLineLength || 2000

/**
 * Simple check for potentially catastrophic regex patterns.
 * Rejects nested quantifiers and excessively repeated wildcards.
 */
function isSafeRegex(pattern) {
  if (pattern.length > MAX_PATTERN_LENGTH) return false
  // Reject nested quantifiers like (a+)+, (a*)+, (a+)*, etc.
  if (/(\+|\*|\{)\s*\)(\+|\*|\{|\?)/.test(pattern)) return false
  // Reject excessive quantifier combinations
  if (/(\.\*){3,}/.test(pattern)) return false
  // Reject alternation (|) operator
  if (/[|]/.test(pattern)) return false
  // Reject groups ( )
  if (/[()]/.test(pattern)) return false
  // Reject backreferences
  if (/\\\d/.test(pattern)) return false
  // Reject patterns with too many quantifiers (potential ReDoS without groups)
  const quantifierCount = (pattern.match(/[?*+]|\{[0-9,]+\}/g) || []).length
  if (quantifierCount > 10) return false
  // Reject consecutive quantified tokens like a?b?c?d?e?f?... which can cause backtracking
  const consecutiveOptional = /(\w[?*+]\s*){4,}/
  if (consecutiveOptional.test(pattern)) return false
  // Reject lookahead/lookbehind
  if (/\(\?/.test(pattern)) return false
  return true
}

const searchProjectSchema = z.object({
  pattern: z
    .string()
    .describe('Regex pattern to search for'),
  path: z
    .string()
    .optional()
    .describe('Restrict to a specific file path'),
  glob: z
    .string()
    .optional()
    .describe('File pattern filter (e.g., "*.tex", "*.bib")'),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT_LINES)
    .optional()
    .describe(`Context lines around matches (default: ${DEFAULT_CONTEXT_LINES}, max: ${MAX_CONTEXT_LINES})`),
})

/**
 * Tool for searching text across project documents
 */
export class SearchProjectTool extends Tool {
  constructor() {
    super({
      name: 'search_project',
      description: `Search for text patterns across all documents in the project.
Returns matching lines with context, similar to grep.
Useful for finding references, labels, citations, definitions, and specific content.
Only searches text documents (not binary files).`,
      parameters: searchProjectSchema,
    })
  }

  /**
   * Execute the search_project tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { pattern, path, glob, context_lines: rawContextLines = DEFAULT_CONTEXT_LINES } = args
    const contextLines = Math.max(0, Math.min(rawContextLines, MAX_CONTEXT_LINES))
    const { adapters, projectId } = context

    // Validate regex safety
    if (!isSafeRegex(pattern)) {
      return ToolResult.error(
        'Pattern is too complex or too long (max 500 characters). Please simplify.'
      )
    }

    // Validate regex syntax
    let regex
    try {
      regex = new RegExp(pattern, 'gi')
    } catch (e) {
      return ToolResult.error(
        `Invalid regex pattern: "${pattern}". Error: ${e.message}`
      )
    }

    if (!adapters.project) {
      return ToolResult.error(
        'Project adapter not available. Cannot search files.'
      )
    }

    // Get files to search
    let filesToSearch = []

    if (path) {
      // Validate and normalize the path
      const pathResult = validateProjectPath(path)
      if (pathResult.error) {
        return ToolResult.error(pathResult.error)
      }
      const normalizedPath = pathResult.path

      // Single file mode
      const docId = await adapters.project.resolvePathToDocId(projectId, normalizedPath)
      if (!docId) {
        return ToolResult.error(
          `File not found: "${path}". Use list_files to see available files.`
        )
      }
      filesToSearch = [{ path: normalizedPath, docId }]
    } else {
      // All docs mode
      const allFiles = await adapters.project.listFiles(projectId, { type: 'docs' })

      // Apply glob filter if provided
      if (glob) {
        const globRegex = globToRegex(glob)
        filesToSearch = allFiles.filter(f => globRegex.test(f.path) || globRegex.test(f.name))
      } else {
        filesToSearch = allFiles
      }

      // Resolve docIds for files that need it
      for (const file of filesToSearch) {
        if (!file.docId) {
          file.docId = await adapters.project.resolvePathToDocId(projectId, file.path)
        }
      }
    }

    if (filesToSearch.length === 0) {
      return ToolResult.success('No matching files to search.', { matchCount: 0 })
    }

    if (filesToSearch.length > DEFAULT_MAX_FILES) {
      return ToolResult.error(
        `Too many files to search (${filesToSearch.length}). ` +
        `Maximum is ${DEFAULT_MAX_FILES}. Use the "path" or "glob" parameter to narrow the scope.`
      )
    }

    // Search each file
    const allMatches = []
    let totalMatchCount = 0
    let totalScannedBytes = 0
    let byteLimitReached = false

    for (const file of filesToSearch) {
      if (!file.docId) continue

      try {
        let { content } = await adapters.document.getDocumentContent(
          projectId,
          file.docId
        )

        // Truncate individual large files to cap memory usage
        if (content.length > MAX_FILE_SIZE) {
          content = content.slice(0, MAX_FILE_SIZE)
        }

        totalScannedBytes += content.length
        if (totalScannedBytes > DEFAULT_MAX_SCAN_BYTES) {
          byteLimitReached = true
          break
        }

        const lines = content.split('\n')
        const fileMatches = []

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].slice(0, MAX_LINE_LENGTH) : lines[i]
          // Reset regex lastIndex for each line (since we use 'g' flag)
          regex.lastIndex = 0
          if (regex.test(line)) {
            fileMatches.push(i)
            totalMatchCount++

            if (totalMatchCount > DEFAULT_MAX_RESULTS) break
          }
        }

        if (fileMatches.length > 0) {
          allMatches.push({
            path: file.path,
            lines,
            matchLineIndices: fileMatches,
          })
        }

        if (totalMatchCount > DEFAULT_MAX_RESULTS) break
      } catch {
        // Skip files that can't be read
        continue
      }
    }

    if (allMatches.length === 0) {
      if (byteLimitReached) {
        return ToolResult.error(
          `Scan byte limit reached (${DEFAULT_MAX_SCAN_BYTES} bytes) before finding any matches. ` +
          'Use the "path" or "glob" parameter to narrow the scope.'
        )
      }
      return ToolResult.success(
        `No matches found for pattern "${pattern}".`,
        { matchCount: 0 }
      )
    }

    // Format output
    const outputParts = []

    for (const fileMatch of allMatches) {
      const { path: filePath, lines, matchLineIndices } = fileMatch
      outputParts.push(`--- ${filePath} ---`)

      // Collect line ranges to display (matches + context, merged)
      const ranges = []
      for (const idx of matchLineIndices) {
        const start = Math.max(0, idx - contextLines)
        const end = Math.min(lines.length - 1, idx + contextLines)
        ranges.push({ start, end, matchIdx: idx })
      }

      // Merge overlapping ranges
      const merged = mergeRanges(ranges)

      for (const range of merged) {
        for (let i = range.start; i <= range.end; i++) {
          const lineNum = String(i + 1).padStart(5)
          const isMatch = range.matchIndices.has(i)
          const prefix = isMatch ? '>' : ' '
          const displayLine = lines[i].length > MAX_LINE_LENGTH ? lines[i].slice(0, MAX_LINE_LENGTH) + '...[truncated]' : lines[i]
          outputParts.push(`${prefix}${lineNum}| ${displayLine}`)
        }
        outputParts.push('')
      }
    }

    const truncated = totalMatchCount > DEFAULT_MAX_RESULTS
    if (truncated) {
      outputParts.push(`[Results limited to ${DEFAULT_MAX_RESULTS} matches. Refine your pattern for more specific results.]`)
    }
    if (byteLimitReached) {
      outputParts.push(`[Scan stopped early: byte limit (${DEFAULT_MAX_SCAN_BYTES} bytes) reached. Use "path" or "glob" to narrow scope.]`)
    }

    const summary = `Found ${totalMatchCount}${truncated ? '+' : ''} matches in ${allMatches.length} file(s).`
    outputParts.unshift(summary, '')

    return ToolResult.success(outputParts.join('\n'), {
      matchCount: totalMatchCount,
      fileCount: allMatches.length,
      truncated,
    })
  }
}

/**
 * Convert a simple glob pattern to a regex
 * Supports * and ? wildcards
 */
function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(escaped, 'i')
}

/**
 * Merge overlapping line ranges
 */
function mergeRanges(ranges) {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged = [{ start: sorted[0].start, end: sorted[0].end, matchIndices: new Set([sorted[0].matchIdx]) }]

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]
    if (sorted[i].start <= last.end + 1) {
      last.end = Math.max(last.end, sorted[i].end)
      last.matchIndices.add(sorted[i].matchIdx)
    } else {
      merged.push({ start: sorted[i].start, end: sorted[i].end, matchIndices: new Set([sorted[i].matchIdx]) })
    }
  }

  return merged
}

export function createSearchProjectTool() {
  return new SearchProjectTool()
}

export default SearchProjectTool
