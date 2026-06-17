import { z } from 'zod'
import crypto from 'node:crypto'
import { Tool, ToolResult } from './Tool.js'
import { validateProjectPath } from '../util/project-path.js'
import settings from '@overleaf/settings'

const deleteFileSchema = z.object({
  path: z
    .string()
    .describe('Path of the file to delete (e.g., "old-draft.tex")'),
})

/**
 * Tool for deleting a file from the project
 * Generates a Pending Change that must be confirmed by the user
 */
export class DeleteFileTool extends Tool {
  constructor() {
    super({
      name: 'delete_file',
      description: `Delete a file from the project.
IMPORTANT: The deletion is NOT immediate — the user must confirm.
NEVER delete files unless the user explicitly asks.
NEVER delete the main document (usually "main.tex") unless explicitly instructed.
Prefer reading the file first to understand what will be lost.
Deleted files can be recovered through Overleaf's version history.`,
      parameters: deleteFileSchema,
    })
  }

  /**
   * Execute the delete_file tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { path } = args
    const { adapters, projectId } = context

    if (!adapters.project) {
      return ToolResult.error(
        'Project adapter not available. Cannot resolve file paths.'
      )
    }

    // Validate and normalize the path
    const pathResult = validateProjectPath(path)
    if (pathResult.error) {
      return ToolResult.error(pathResult.error)
    }
    const normalizedPath = pathResult.path

    // Resolve path to entity
    const entity = await adapters.project.resolvePathToEntity(projectId, normalizedPath)

    if (!entity) {
      return ToolResult.error(
        `File not found: "${path}". Use list_files to see available files.`
      )
    }

    // Read content for preview
    let deletedContent = null
    let isBinary = false

    if (entity.type === 'doc') {
      // Text document — read content for preview
      try {
        const { content } = await adapters.document.getDocumentContent(
          projectId,
          entity.id
        )
        deletedContent = content
        const MAX_DELETED_CONTENT_CHARS = settings.document?.deletePreviewMaxChars || 50_000
        if (deletedContent && deletedContent.length > MAX_DELETED_CONTENT_CHARS) {
          deletedContent = deletedContent.slice(0, MAX_DELETED_CONTENT_CHARS) + '\n...[content truncated]'
        }
      } catch {
        deletedContent = '[Unable to read file content]'
      }
    } else {
      // Binary file — cannot preview
      isBinary = true
      deletedContent = `[Binary file: ${entity.name}]`
    }

    const changeId = crypto.randomBytes(12).toString('hex')

    const pendingChange = {
      id: changeId,
      type: 'delete',
      projectId,
      entityId: entity.id,
      entityType: entity.type,
      path: normalizedPath,
      deletedContent,
      isBinary,
      status: 'pending',
      createdAt: Date.now(),
    }

    const output = formatDeleteOutput(pendingChange, normalizedPath, isBinary)

    return ToolResult.success(output, {
      needsConfirmation: true,
      change: pendingChange,
      changeId,
    })
  }
}

/**
 * Format the delete output for display
 */
function formatDeleteOutput(change, docPath, isBinary) {
  const lines = [
    `🗑️ Delete queued (pending user confirmation)`,
    ``,
    `File: ${docPath}`,
    `Change ID: ${change.id}`,
    `Type: ${change.entityType}`,
  ]

  if (isBinary) {
    lines.push(``, `⚠️ Binary file — content cannot be previewed`)
  } else {
    const preview = change.deletedContent || ''
    const previewLines = preview.split('\n')
    const lineCount = previewLines.length
    lines.push(`Lines: ${lineCount}`)
    lines.push(``, `--- Content to be deleted ---`)
    if (preview.length > 500) {
      lines.push(preview.slice(0, 500) + '...[truncated]')
    } else {
      lines.push(preview)
    }
  }

  lines.push(``, `Status: Pending confirmation`)

  return lines.join('\n')
}

export function createDeleteFileTool() {
  return new DeleteFileTool()
}

export default DeleteFileTool
