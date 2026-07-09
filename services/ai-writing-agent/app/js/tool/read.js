import { z } from 'zod'
import crypto from 'node:crypto'
import { Tool, ToolResult } from './Tool.js'
import { truncateByLinesAndChars, extractLatexSection } from '../util/truncation.js'
import { generateTruncationOutline } from '../util/outline.js'
import { validateProjectPath, projectPathToWorkspaceRelative } from '../util/project-path.js'
import { assertPathAllowedByGlobs, AgentPolicyPathError } from '../agent-team/policyPathGuard.js'
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
    const sandboxSession = context.persistentWorkspace?.sandboxSession

    const { heading, offset } = args
    const effectiveLimit = Math.min(args.limit || DEFAULT_MAX_LINES, MAX_READ_LINES)
    const maxChars = DEFAULT_MAX_CHARS

    if (sandboxSession) {
      return this._executeWorkspace(args, context, {
        sandboxSession,
        heading,
        offset,
        effectiveLimit,
        maxChars,
      })
    }

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
      assertPathAllowedByGlobs(docPath, context.fileGlobs, 'read')
    } catch (error) {
      if (error instanceof AgentPolicyPathError) {
        return ToolResult.error(error.message, { code: error.code })
      }
      throw error
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

  async _executeWorkspace(args, context, options) {
    const { adapters, projectId, sessionState, currentDocPath, currentDocId } = context
    const { sandboxSession, heading, offset, effectiveLimit, maxChars } = options
    const requestedPath = args.path || currentDocPath

    if (!requestedPath) {
      return ToolResult.error(
        'No document is currently open. Please specify a path parameter, or the user should open a document first.'
      )
    }

    const pathResult = validateProjectPath(requestedPath)
    if (pathResult.error) {
      return ToolResult.error(pathResult.error)
    }

    const docPath = pathResult.path
    const workspacePath = projectPathToWorkspaceRelative(docPath)

    try {
      assertPathAllowedByGlobs(docPath, context.fileGlobs, 'read')
    } catch (error) {
      if (error instanceof AgentPolicyPathError) {
        return ToolResult.error(error.message, { code: error.code })
      }
      throw error
    }

    try {
      let canonicalDocId = currentDocId || null
      if (args.path && adapters?.project) {
        canonicalDocId =
          (await adapters.project.resolvePathToDocId(projectId, docPath)) ||
          canonicalDocId
      }
      let canonicalVersion = null
      if (canonicalDocId && adapters?.document) {
        try {
          const canonicalDoc = await adapters.document.getDocumentContent(
            projectId,
            canonicalDocId
          )
          canonicalVersion = canonicalDoc.version
        } catch {
          canonicalVersion = null
        }
      }
      const content = toUtf8(await sandboxSession.readFile(workspacePath))
      const version = workspaceContentVersion(content)

      if (sessionState) {
        if (!sessionState.readDocuments) {
          sessionState.readDocuments = new Map()
        }
        sessionState.readDocuments.set(workspaceReadKey(workspacePath), {
          version,
          path: workspacePath,
          workspace: true,
          docId: canonicalDocId,
          entityId: canonicalDocId,
          baseVersion: canonicalVersion,
          canonicalVersion,
          readAt: Date.now(),
        })
      }

      return formatReadResult({
        content,
        docPath,
        docId: canonicalDocId || workspacePath,
        projectId: context.projectId,
        version,
        heading,
        offset,
        effectiveLimit,
        maxChars,
        workspace: true,
      })
    } catch (error) {
      return ToolResult.error(`Document not found: ${docPath}`)
    }
  }
}

function formatReadResult({
  content,
  docPath,
  docId,
  projectId,
  version,
  heading,
  offset,
  effectiveLimit,
  maxChars,
  workspace = false,
}) {
  const fullContent = content
  let resultContent = content
  const metadata = { version, totalLines: content.split('\n').length }
  let baseLineNumber = 1

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
    const allLines = resultContent.split('\n')
    const startIdx = offset - 1
    if (startIdx >= allLines.length) {
      return ToolResult.error(
        `Offset ${offset} exceeds document length (${allLines.length} lines).`
      )
    }
    resultContent = allLines.slice(startIdx).join('\n')
    baseLineNumber = offset
  }

  const truncResult = truncateByLinesAndChars(resultContent, effectiveLimit, maxChars)
  resultContent = truncResult.text
  metadata.truncated = truncResult.truncated
  metadata.returnedLines = truncResult.truncatedAtLine

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
    workspace,
    ...metadata,
  })
}

export function workspaceReadKey(workspacePath) {
  return `workspace:${workspacePath}`
}

export function workspaceContentVersion(content) {
  return crypto.createHash('sha256').update(toUtf8(content)).digest('hex')
}

export function toUtf8(content) {
  if (Buffer.isBuffer(content)) return content.toString('utf8')
  if (content instanceof Uint8Array) return Buffer.from(content).toString('utf8')
  return String(content ?? '')
}

export function createReadDocumentTool() {
  return new ReadDocumentTool()
}

export default ReadDocumentTool
