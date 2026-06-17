import { z } from 'zod'
import path from 'node:path'
import settings from '@overleaf/settings'
import { Tool, ToolResult } from './Tool.js'

const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const viewFileSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to the image file in the project (e.g., "figures/diagram.png")'
    ),
})

/**
 * Tool for viewing image files in the project.
 * Downloads the binary file and returns it as base64 image content
 * for injection into the LLM conversation.
 */
export class ViewFileTool extends Tool {
  constructor() {
    super({
      name: 'view_file',
      description: `View an image file in the project. Supports PNG, JPG, JPEG, GIF, and WebP formats.
Use this to see figures, diagrams, screenshots, or other images the user references.
The image will be displayed inline so you can describe or analyze its content.`,
      parameters: viewFileSchema,
    })
  }

  /**
   * Execute the view_file tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { adapters, projectId, userId } = context

    if (!adapters.project) {
      return ToolResult.error(
        'Project adapter not available. Cannot resolve file paths.'
      )
    }

    // Reject backslashes (Windows-style path separators)
    if (args.path.includes('\\')) {
      return ToolResult.error('Invalid path: backslashes are not allowed.')
    }

    // Reject URL-encoded path separators and dot characters
    if (/%(?:2e|2f|5c)/i.test(args.path)) {
      return ToolResult.error(
        'Invalid path: encoded path characters are not allowed.'
      )
    }

    // Reject path traversal (raw input check)
    if (args.path.split('/').includes('..')) {
      return ToolResult.error('Invalid path: ".." segments are not allowed.')
    }

    const normalizedPath = path.posix.normalize(
      args.path.startsWith('/') ? args.path : '/' + args.path
    )

    // Reject path traversal after normalization (catches edge cases)
    if (normalizedPath.split('/').includes('..')) {
      return ToolResult.error('Invalid path: ".." segments are not allowed.')
    }

    // Resolve path to entity
    const entity = await adapters.project.resolvePathToEntity(
      projectId,
      normalizedPath
    )

    if (!entity) {
      return ToolResult.error(
        `File not found: "${args.path}". Use list_files to see available files.`
      )
    }

    if (entity.type !== 'file') {
      return ToolResult.error(
        `"${args.path}" is a text document, not a binary file. Use read_document to read text files.`
      )
    }

    // Validate extension
    const ext = path.extname(entity.name).toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return ToolResult.error(
        `Unsupported image format: "${ext}". Supported formats: ${ALLOWED_EXTENSIONS.join(', ')}`
      )
    }

    // Check if model supports image
    if (!adapters.llm?.supportsImage()) {
      return ToolResult.error(
        `The current model does not support image inputs. File: ${args.path}`
      )
    }

    // Download the file
    if (!adapters.fileStore) {
      return ToolResult.error(
        'FileStore adapter not available. Cannot download binary files.'
      )
    }

    try {
      const buffer = await adapters.fileStore.downloadProjectFile(
        projectId,
        entity.id,
        userId
      )

      // Enforce file size limit to prevent memory/context explosion
      const maxSize = settings.image?.maxSize || 5 * 1024 * 1024
      if (buffer.length > maxSize) {
        return ToolResult.error(
          `Image file "${args.path}" is too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Maximum allowed: ${(maxSize / 1024 / 1024).toFixed(1)}MB.`
        )
      }

      const mimeType = MIME_MAP[ext]
      const base64Data = buffer.toString('base64')
      const filename = entity.name

      return ToolResult.success(
        `Image file loaded: ${args.path} (${mimeType}, ${buffer.length} bytes)`,
        {
          _imageContent: {
            mimeType,
            base64Data,
            filename,
          },
        }
      )
    } catch (error) {
      return ToolResult.error(
        `Failed to download file "${args.path}": ${error.message}`
      )
    }
  }
}

export function createViewFileTool() {
  return new ViewFileTool()
}

export default ViewFileTool
