import { z } from 'zod'
import crypto from 'node:crypto'
import { Tool, ToolResult } from './Tool.js'
import { EditMatchError } from '../adapter/DocumentAdapter.js'
import { replace } from '../util/replacer.js'
import { validateProjectPath } from '../util/project-path.js'
import settings from '@overleaf/settings'

const MAX_OLD_TEXT_LENGTH = settings.documentEdit?.maxOldTextLength || 102400
const MAX_NEW_TEXT_LENGTH = settings.documentEdit?.maxNewTextLength || 102400

const editDocumentSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'File path (e.g., "main.tex"). Omit to edit the current document.'
    ),
  oldText: z.string().max(MAX_OLD_TEXT_LENGTH, 'oldText exceeds 100KB limit').describe('The exact text to replace (must match the document content)'),
  newText: z.string().max(MAX_NEW_TEXT_LENGTH, 'newText exceeds 100KB limit').describe('The replacement text (must be different from oldText)'),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      'Replace all occurrences of oldText (default false). Use to rename a variable or replace all instances of a string.'
    ),
})

/**
 * Tool for editing document content
 * Generates a Pending Change that must be confirmed by the user
 */
export class EditDocumentTool extends Tool {
  constructor() {
    super({
      name: 'edit_document',
      description: `Edit a document by replacing specific text.
IMPORTANT: You must read the document first using read_document before editing.
If no path is provided, edits the currently open document.
The oldText must match the document content — use read_document to get the current content.
The edit will FAIL if oldText is not found in the document.
The edit will FAIL if oldText matches multiple locations — provide more surrounding context to make it unique, or use replaceAll.
This creates a pending change that the user must confirm before it is applied.`,
      parameters: editDocumentSchema,
    })
  }

  /**
   * Execute the edit_document tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { path, oldText, newText, replaceAll = false } = args
    const {
      adapters,
      sessionState,
      projectId,
      currentDocPath,
      currentDocId,
    } = context

    // Determine which document to edit
    let docId
    let docPath

    if (path) {
      // Validate and normalize the path
      const pathResult = validateProjectPath(path)
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
        // File not found — check if this is a create operation
        if (oldText === '') {
          // Check if a non-doc entity (binary file or folder) already exists at this path
          const existingEntity = await adapters.project.resolvePathToEntity(projectId, normalizedPath)
          if (existingEntity) {
            return ToolResult.error(
              `Cannot create doc: a ${existingEntity.type || 'file'} already exists at path "${normalizedPath}"`
            )
          }

          // Create mode: generate a 'create' PendingChange
          const changeId = crypto.randomBytes(12).toString('hex')

          const pendingChange = {
            id: changeId,
            type: 'create',
            projectId,
            path: normalizedPath,
            content: newText,
            status: 'pending',
            createdAt: Date.now(),
          }

          return ToolResult.success(formatCreateOutput(pendingChange, normalizedPath), {
            needsConfirmation: true,
            change: pendingChange,
            changeId: pendingChange.id,
          })
        }

        return ToolResult.error(
          `File not found: "${path}". Use list_files to see available files.`
        )
      }
      docPath = path.startsWith('/') ? path : `/${path}`
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

    // Enforce read-before-write policy
    const docKey = `${projectId}:${docId}`
    const readInfo = sessionState?.readDocuments?.get(docKey)

    if (!readInfo) {
      return ToolResult.error(
        `You must read the document first using read_document before editing. ` +
          `Call read_document with path="${docPath}" first.`
      )
    }

    // Version staleness check: detect external modifications since last read
    try {
      const { version: currentVersion } = await adapters.document.getDocumentContent(
        projectId,
        docId
      )
      if (currentVersion !== readInfo.version) {
        return ToolResult.error(
          `Document has been modified since you last read it (read: v${readInfo.version}, current: v${currentVersion}). ` +
          `Please call read_document to get the latest content before editing.`
        )
      }
    } catch {
      // Non-critical: if version check fails, continue with the edit
    }

    // Validate that oldText and newText are different
    if (oldText === newText) {
      return ToolResult.error(
        'oldText and newText are identical. No change would be made.'
      )
    }

    // Validate text is not empty
    if (!oldText.trim()) {
      return ToolResult.error('oldText cannot be empty.')
    }

    try {
      if (replaceAll) {
        // replaceAll mode: use replace() from replacer, build pending change manually
        const { content, version } = await adapters.document.getDocumentContent(
          projectId,
          docId
        )

        const { newContent, matchedText } = replace(content, oldText, newText, true)

        // Count how many replacements were made
        const occurrences = content.split(matchedText).length - 1

        // Build a synthetic pending change for replaceAll
        const changeId = crypto.randomBytes(12).toString('hex')

        const pendingChange = {
          id: changeId,
          projectId,
          docId,
          baseVersion: version,
          position: null, // replaceAll doesn't have a single position
          oldText: matchedText,
          newText,
          replaceAll: true,
          newContent,
          status: 'pending',
          createdAt: Date.now(),
          path: docPath,
        }

        const output = [
          `✏️ Replace-all queued (pending user confirmation)`,
          ``,
          `File: ${docPath}`,
          `Change ID: ${changeId}`,
          `Occurrences: ${occurrences}`,
          ``,
          `--- Find ---`,
          truncateText(matchedText, 500),
          ``,
          `--- Replace with ---`,
          truncateText(newText, 500),
          ``,
          `Status: Awaiting confirmation`,
        ].join('\n')

        return ToolResult.success(output, {
          needsConfirmation: true,
          change: pendingChange,
          changeId,
        })
      }

      // Single replacement mode: use previewEdit from DocumentAdapter
      const pendingChange = await adapters.document.previewEdit(
        projectId,
        docId,
        oldText,
        newText
      )

      // Add path to pending change for display
      pendingChange.path = docPath

      // Calculate line numbers for display
      const { content } = await adapters.document.getDocumentContent(
        projectId,
        docId
      )
      const startPos = adapters.document.positionToLineColumn(
        content,
        pendingChange.position.start
      )
      const endPos = adapters.document.positionToLineColumn(
        content,
        pendingChange.position.end
      )

      // Build success output
      const output = formatEditOutput(pendingChange, startPos, endPos, docPath)

      return ToolResult.success(output, {
        needsConfirmation: true,
        change: pendingChange,
        changeId: pendingChange.id,
      })
    } catch (error) {
      if (error instanceof EditMatchError) {
        const isMultipleMatches = error.info?.multipleMatches
        let message

        if (isMultipleMatches) {
          message =
            `Text matches multiple locations in "${docPath}".\n\n` +
            `Error: ${error.message}\n\n` +
            `Tip: Include more surrounding lines in oldText to make it unique, ` +
            `or use replaceAll to replace every occurrence.`
        } else {
          message =
            `Could not find the specified text to replace in "${docPath}". ` +
            `Please use read_document to get the current content and ensure oldText matches exactly.\n\n` +
            `Error: ${error.message}`
        }

        return ToolResult.error(message)
      }
      // Also catch ReplacerMatchError from replaceAll path
      if (error.name === 'ReplacerMatchError') {
        const isMultipleMatches = error.info?.multipleMatches
        let message

        if (isMultipleMatches) {
          message =
            `Text matches multiple locations in "${docPath}".\n\n` +
            `Error: ${error.message}\n\n` +
            `Tip: Include more surrounding lines in oldText to make it unique, ` +
            `or use replaceAll to replace every occurrence.`
        } else {
          message =
            `Could not find the specified text to replace in "${docPath}". ` +
            `Please use read_document to get the current content and ensure oldText matches exactly.\n\n` +
            `Error: ${error.message}`
        }

        return ToolResult.error(message)
      }
      throw error
    }
  }
}

/**
 * Format the create output for display
 */
function formatCreateOutput(change, docPath) {
  const content = change.content || ''
  const lineCount = content.split('\n').length

  const lines = [
    `📄 Create proposed (awaiting user confirmation)`,
    ``,
    `File: ${docPath}`,
    `Change ID: ${change.id}`,
    `Lines: ${lineCount}`,
    ``,
    `--- New file content ---`,
    truncateText(content, 500),
    ``,
    `Status: Awaiting confirmation`,
  ]

  return lines.join('\n')
}

/**
 * Format the edit output for display
 */
function formatEditOutput(change, startPos, endPos, docPath) {
  const lines = [
    `✏️ Edit proposed (awaiting user confirmation)`,
    ``,
    `File: ${docPath}`,
    `Change ID: ${change.id}`,
    `Location: Lines ${startPos.line}-${endPos.line}`,
    ``,
    `--- Before ---`,
    truncateText(change.oldText, 500),
    ``,
    `--- After ---`,
    truncateText(change.newText, 500),
    ``,
    `Status: Awaiting confirmation`,
  ]

  return lines.join('\n')
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(0, maxLength) + '...[truncated]'
}

export function createEditDocumentTool() {
  return new EditDocumentTool()
}

export default EditDocumentTool
