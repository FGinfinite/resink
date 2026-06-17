import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import settings from '@overleaf/settings'

const MAX_PATTERN_LENGTH = settings.list?.maxPatternLength || 200

const listFilesSchema = z.object({
  pattern: z
    .string()
    .max(MAX_PATTERN_LENGTH, `Pattern too long (max ${MAX_PATTERN_LENGTH} characters).`)
    .optional()
    .describe('Glob pattern to filter files (e.g., "*.tex", "chapters/*.tex")'),
  type: z
    .enum(['all', 'docs', 'files'])
    .optional()
    .default('all')
    .describe(
      'Type of files to list: "all" (default), "docs" (text documents), "files" (binary files)'
    ),
})

/**
 * Tool for listing project files
 */
export class ListFilesTool extends Tool {
  constructor() {
    super({
      name: 'list_files',
      description: `List all files in the project.
Returns file paths, types (doc or file), and line counts for text documents.
Use pattern to filter files (supports * and ? wildcards).
Use type to show only documents or binary files.`,
      parameters: listFilesSchema,
    })
  }

  /**
   * Execute the list_files tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { pattern, type } = args
    const { adapters, projectId } = context

    if (!adapters.project) {
      return ToolResult.error(
        'Project adapter not available. Cannot list files.'
      )
    }

    try {
      const files = await adapters.project.listFiles(projectId, {
        type,
        pattern,
      })

      if (files.length === 0) {
        if (pattern) {
          return ToolResult.success(
            `No files found matching pattern "${pattern}".`,
            { count: 0 }
          )
        }
        return ToolResult.success('No files found in project.', { count: 0 })
      }

      // Get line counts for doc files (if not too many)
      const docFiles = files.filter(f => f.type === 'doc')
      const lineCountMap = new Map()

      if (docFiles.length <= (settings.list?.lineCountMaxFiles || 50) && adapters.document) {
        const results = await Promise.allSettled(
          docFiles.map(async (file) => {
            const docId = file.docId || await adapters.project.resolvePathToDocId(projectId, file.path)
            if (!docId) return { path: file.path, lines: null }
            const { content } = await adapters.document.getDocumentContent(projectId, docId)
            return { path: file.path, lines: content.split('\n').length }
          })
        )

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.lines != null) {
            lineCountMap.set(result.value.path, result.value.lines)
          }
        }
      }

      // Format output
      const lines = [`Project files (${files.length} total):`, '']

      // Group by directory for better readability
      const byDirectory = new Map()
      for (const file of files) {
        const dir = file.path.substring(0, file.path.lastIndexOf('/')) || '/'
        if (!byDirectory.has(dir)) {
          byDirectory.set(dir, [])
        }
        byDirectory.get(dir).push(file)
      }

      // Sort directories
      const sortedDirs = [...byDirectory.keys()].sort()

      for (const dir of sortedDirs) {
        lines.push(`📁 ${dir}/`)
        const dirFiles = byDirectory.get(dir)
        for (const file of dirFiles) {
          const icon = file.type === 'doc' ? '📄' : '📎'
          const name = file.name
          const lineCount = lineCountMap.get(file.path)
          const lineSuffix = lineCount != null ? ` (${lineCount} lines)` : ''
          lines.push(`   ${icon} ${name}${lineSuffix}`)
        }
        lines.push('')
      }

      return ToolResult.success(lines.join('\n'), {
        count: files.length,
        files: files.map(f => ({
          path: f.path,
          type: f.type,
          lines: lineCountMap.get(f.path) || undefined,
        })),
      })
    } catch (error) {
      if (error.code === 'PROJECT_NOT_FOUND') {
        return ToolResult.error('Project not found.')
      }
      // Return a descriptive error instead of throwing, so LLM gets useful feedback
      return ToolResult.error(
        `Failed to list project files: ${error.message}`
      )
    }
  }
}

export function createListFilesTool() {
  return new ListFilesTool()
}

export default ListFilesTool
