import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { truncateByLinesAndChars, extractLatexSection } from '../util/truncation.js'
import { generateTruncationOutline } from '../util/outline.js'
import { validateProjectPath } from '../util/project-path.js'
import settings from '@overleaf/settings'

const DEFAULT_MAX_LINES = settings.document?.maxLines || 1000
const MAX_READ_LINES = settings.document?.maxReadLines || 2000
const DEFAULT_MAX_CHARS = settings.document?.maxChars || 50000

const readDocumentSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'File path (e.g., "main.tex" or "/chapters/intro.tex"). Omit to read the current document.'
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start reading from'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_LINES)
    .optional()
    .describe(`Maximum lines to return (default: ${DEFAULT_MAX_LINES}, max: ${MAX_READ_LINES})`),
  heading: z
    .string()
    .optional()
    .describe(
      'Extract a specific LaTeX heading by name (e.g., "Introduction"). ' +
      'Works with \\part, \\chapter, \\section, \\subsection, \\subsubsection. ' +
      'Only for .tex files.'
    ),
})

/**
 * Tool for reading document content
 */
export class ReadDocumentTool extends Tool {
  constructor() {
    super({
      name: 'read_document',
      description: `Read the content of a document in the project.
Returns the full document content, a specific heading/section, or a paginated slice.
If no path is provided, reads the currently open document.
Use heading to extract a specific LaTeX section by name (only .tex files).
Use offset/limit for pagination of large documents.
Large results are automatically truncated with navigation hints.`,
      parameters: readDocumentSchema,
    })
  }

  /**
   * Execute the read_document tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { adapters, sessionState, projectId, currentDocPath, currentDocId } =
      context

    const { heading, offset } = args
    const effectiveLimit = Math.min(args.limit || DEFAULT_MAX_LINES, MAX_READ_LINES)
    const maxChars = DEFAULT_MAX_CHARS

    // Determine which document to read
    let docId
    let docPath

    if (args.path) {
      // Validate and normalize the path
      const pathResult = validateProjectPath(args.path)
      if (pathResult.error) {
        return ToolResult.error(pathResult.error)
      }
      const normalizedPath = pathResult.path

      // Resolve path to docId using ProjectAdapter
      if (!adapters.project) {
        return ToolResult.error(
          'Project adapter not available. Cannot resolve file paths.'
        )
      }

      docId = await adapters.project.resolvePathToDocId(projectId, normalizedPath)
      if (!docId) {
        return ToolResult.error(
          `File not found: "${args.path}". Use list_files to see available files.`
        )
      }
      docPath = normalizedPath
    } else {
      // Use current document from context
      if (!currentDocId) {
        return ToolResult.error(
          'No document is currently open. Please specify a path parameter, or the user should open a document first.'
        )
      }
      docId = currentDocId
      docPath = currentDocPath || '(current document)'
    }

    try {
      // Get document content
      const { content, version } = await adapters.document.getDocumentContent(
        projectId,
        docId
      )

      // Track that this document was read (for read-before-write validation)
      if (sessionState) {
        if (!sessionState.readDocuments) {
          sessionState.readDocuments = new Map()
        }
        sessionState.readDocuments.set(`${projectId}:${docId}`, {
          version,
          readAt: Date.now(),
        })
      }

      const fullContent = content
      let resultContent = content
      const metadata = { version, totalLines: content.split('\n').length }
      let baseLineNumber = 1

      // heading extraction (only for .tex files)
      if (heading) {
        if (!docPath.endsWith('.tex')) {
          return ToolResult.error(
            `The heading parameter only works with .tex files. Use search_project to search in "${docPath}".`
          )
        }
        const extracted = extractLatexSection(content, heading)
        if (!extracted.found) {
          return ToolResult.error(
            `Section "${heading}" not found in document.`
          )
        }
        resultContent = extracted.content
        metadata.heading = heading
        metadata.headingStartLine = extracted.startLine
        metadata.headingEndLine = extracted.endLine
        baseLineNumber = extracted.startLine
      } else if (offset && offset > 1) {
        // Apply offset (skip lines)
        const allLines = resultContent.split('\n')
        const startIdx = offset - 1 // 0-based
        if (startIdx >= allLines.length) {
          return ToolResult.error(
            `Offset ${offset} exceeds document length (${allLines.length} lines).`
          )
        }
        resultContent = allLines.slice(startIdx).join('\n')
        baseLineNumber = offset
      }

      // Dual truncation
      const truncResult = truncateByLinesAndChars(resultContent, effectiveLimit, maxChars)
      resultContent = truncResult.text
      metadata.truncated = truncResult.truncated
      metadata.returnedLines = truncResult.truncatedAtLine

      // Add line numbers with correct base offset
      const contentLines = resultContent.split('\n')
      const lastLine = baseLineNumber + contentLines.length - 1
      const padWidth = String(lastLine).length
      const numberedContent = contentLines
        .map((line, i) => `${String(baseLineNumber + i).padStart(padWidth, '0')}| ${line}`)
        .join('\n')
      let output =
        `Document: ${docPath} (version ${version}, lines ${baseLineNumber}-${lastLine}):\n\n` +
        numberedContent

      if (truncResult.truncated) {
        const truncatedAtAbsLine = baseLineNumber + truncResult.truncatedAtLine - 1
        output += `\n\n[Showing ${truncResult.truncatedAtLine} of ${truncResult.totalLines} lines]`

        // Auto-outline for .tex files
        if (docPath.endsWith('.tex')) {
          const outline = generateTruncationOutline(fullContent, truncatedAtAbsLine + 1)
          if (outline) {
            output += `\n\nRemaining document structure:\n${outline}`
          }
        }

        output += `\n\nUse offset=${truncatedAtAbsLine + 1} to continue reading.`
      } else {
        output += `\n\n(End of file — total ${metadata.totalLines} lines)`
      }

      return ToolResult.success(output, {
        projectId,
        docId,
        path: docPath,
        version,
        ...metadata,
      })
    } catch (error) {
      if (error.code === 'DOCUMENT_NOT_FOUND') {
        return ToolResult.error(`Document not found: ${docPath}`)
      }
      throw error
    }
  }
}

export function createReadDocumentTool() {
  return new ReadDocumentTool()
}

export default ReadDocumentTool
