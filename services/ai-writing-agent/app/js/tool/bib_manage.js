import path from 'node:path'
import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { parseBibFile, findDuplicates, normalizeBibEntry, sortEntries } from '../util/bibtex.js'
import { extractCitations, extractBibResources } from '../util/latex-refs.js'

const REQUIRED_FIELDS = {
  article: ['author', 'title', 'year', 'journal'],
  inproceedings: ['author', 'title', 'booktitle', 'year'],
  book: ['title', 'publisher', 'year'], // author OR editor
  default: ['author', 'title', 'year'],
}

const bibManageSchema = z.object({
  action: z.enum(['validate', 'dedupe', 'find_unused', 'find_missing', 'normalize', 'sort'])
    .describe('Action to perform on the bibliography'),
  bib_path: z.string().optional()
    .describe('Path to .bib file. Auto-detected if not specified.'),
  sort_by: z.enum(['key', 'year', 'author']).default('key').optional()
    .describe('Sort order for sort action'),
})

export class BibManageTool extends Tool {
  constructor() {
    super({
      name: 'bib_manage',
      description: `Manage and audit BibTeX bibliography files. Actions:
- validate: Check entries for missing required fields
- dedupe: Find duplicate entries (by DOI or title+year)
- find_unused: Find .bib entries not cited in any .tex file
- find_missing: Find citations in .tex files with no matching .bib entry
- normalize: Preview normalization changes (month abbreviations, DOI cleanup)
- sort: Preview alphabetical reordering of entries
All actions are report-only and do not modify files.`,
      parameters: bibManageSchema,
    })
  }

  /**
   * Auto-detect the .bib file path in the project.
   * First checks for \bibliography{} or \addbibresource{} in .tex files,
   * then falls back to finding any .bib file.
   * @param {string} projectId
   * @param {object} adapters
   * @returns {Promise<string[]|null>}
   */
  async _findBibPath(projectId, adapters) {
    const allFiles = await adapters.project.listFiles(projectId, { type: 'docs' })

    // Try scanning .tex files for \bibliography{} or \addbibresource{}
    const bibPaths = new Set()
    const texFiles = allFiles.filter(f => f.path.endsWith('.tex'))

    // Resolve docIds and read content serially to avoid unbounded parallel I/O
    const texFilesWithDocIds = []
    for (const file of texFiles) {
      try {
        const docId = file.docId || await adapters.project.resolvePathToDocId(projectId, file.path)
        if (!docId) continue
        const { content } = await adapters.document.getDocumentContent(projectId, docId)
        texFilesWithDocIds.push({ file, content })
      } catch {
        continue
      }
    }

    for (const { file, content } of texFilesWithDocIds) {
      const bibResources = extractBibResources(content, file.path)
      for (const res of bibResources) {
        // \bibliography can have comma-separated paths
        const paths = res.path.split(',').map(p => p.trim()).filter(Boolean)
        const resDir = path.posix.dirname(res.file)
        for (let bibPath of paths) {
          if (!bibPath.endsWith('.bib')) bibPath += '.bib'
          // Resolve relative to the file that contains the command
          if (!bibPath.startsWith('/')) {
            bibPath = path.posix.normalize(path.posix.join(resDir, bibPath))
            if (!bibPath.startsWith('/')) bibPath = '/' + bibPath
          }
          bibPaths.add(bibPath)
        }
      }
    }

    if (bibPaths.size > 0) {
      return Array.from(bibPaths)
    }

    // Fallback: find any .bib file directly
    const bibFiles = allFiles.filter(f => f.path.endsWith('.bib'))
    if (bibFiles.length > 0) {
      return bibFiles.map(f => f.path)
    }

    return null
  }

  /**
   * Read the content of a .bib file by path.
   * @param {string} projectId
   * @param {string} bibPath
   * @param {object} adapters
   * @returns {Promise<string>}
   */
  async _readBibContent(projectId, bibPath, adapters) {
    const docId = await adapters.project.resolvePathToDocId(projectId, bibPath)
    if (!docId) {
      throw new Error(`Bib file not found: "${bibPath}"`)
    }
    const { content } = await adapters.document.getDocumentContent(projectId, docId)
    return content
  }

  /**
   * Collect all cited keys from all .tex files in the project.
   * @param {string} projectId
   * @param {object} adapters
   * @returns {Promise<Map<string, Array<{file: string, line: number, command: string}>>>}
   */
  async _collectCitations(projectId, adapters) {
    const allFiles = await adapters.project.listFiles(projectId, { type: 'docs' })
    const texFiles = allFiles.filter(f => f.path.endsWith('.tex'))

    /** @type {Map<string, Array<{file: string, line: number, command: string}>>} */
    const citedKeys = new Map()

    // Read all .tex files serially to avoid unbounded parallel I/O
    for (const file of texFiles) {
      try {
        const docId = file.docId || await adapters.project.resolvePathToDocId(projectId, file.path)
        if (!docId) continue
        const { content } = await adapters.document.getDocumentContent(projectId, docId)
        const citations = extractCitations(content, file.path)
        for (const cite of citations) {
          for (const key of cite.keys) {
            if (!citedKeys.has(key)) citedKeys.set(key, [])
            citedKeys.get(key).push({
              file: cite.file,
              line: cite.line,
              command: cite.command,
            })
          }
        }
      } catch {
        continue
      }
    }

    return citedKeys
  }

  /**
   * Execute the bib_manage tool.
   * @param {object} args
   * @param {object} context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { action, bib_path: bibPathArg } = args
    const { adapters, projectId } = context

    if (!adapters.project || !adapters.document) {
      return ToolResult.error('Project or document adapter not available.')
    }

    // Validate and sanitize bib_path if provided
    let sanitizedBibPath = bibPathArg
    if (sanitizedBibPath) {
      // Ensure .bib extension
      if (!sanitizedBibPath.endsWith('.bib')) sanitizedBibPath += '.bib'
      // Normalize and check for traversal
      sanitizedBibPath = sanitizedBibPath.startsWith('/') ? sanitizedBibPath : '/' + sanitizedBibPath
      sanitizedBibPath = path.posix.normalize(sanitizedBibPath)
      if (sanitizedBibPath.split('/').includes('..')) {
        return ToolResult.error('Invalid bib_path: path traversal not allowed')
      }
    }

    // Resolve bib paths (support multiple .bib files)
    const bibPaths = sanitizedBibPath ? [sanitizedBibPath] : await this._findBibPath(projectId, adapters)
    if (!bibPaths || bibPaths.length === 0) {
      return ToolResult.error(
        'No .bib file found in the project. Specify bib_path explicitly or add a \\bibliography{} command to your .tex files.'
      )
    }

    // Read and parse all bib files, merging entries
    const allEntries = []
    const bibPathLabel = bibPaths.join(', ')
    for (const bp of bibPaths) {
      try {
        const content = await this._readBibContent(projectId, bp, adapters)
        allEntries.push(...parseBibFile(content))
      } catch (e) {
        return ToolResult.error(e.message)
      }
    }

    if (allEntries.length === 0) {
      return ToolResult.success(`No BibTeX entries found in ${bibPathLabel}.`)
    }

    switch (action) {
      case 'validate':
        return this._validate(allEntries, bibPathLabel)
      case 'dedupe':
        return this._dedupe(allEntries, bibPathLabel)
      case 'find_unused':
        return await this._findUnused(allEntries, bibPathLabel, projectId, adapters)
      case 'find_missing':
        return await this._findMissing(allEntries, bibPathLabel, projectId, adapters)
      case 'normalize':
        return this._normalize(allEntries, bibPathLabel)
      case 'sort':
        return this._sort(allEntries, bibPathLabel, args)
      default:
        return ToolResult.error(`Unknown action: ${action}`)
    }
  }

  /**
   * Validate entries for missing required fields.
   */
  _validate(entries, bibPath) {
    const issues = []

    const isFieldMissing = (value) => value == null || (typeof value === 'string' && value.trim() === '')

    for (const entry of entries) {
      const required = REQUIRED_FIELDS[entry.type] || REQUIRED_FIELDS.default

      // Special case for book: needs author OR editor
      if (entry.type === 'book') {
        const hasAuthorOrEditor = !isFieldMissing(entry.fields.author) || !isFieldMissing(entry.fields.editor)
        const missing = required.filter(f => isFieldMissing(entry.fields[f]))
        if (!hasAuthorOrEditor) missing.unshift('author or editor')
        if (missing.length > 0) {
          issues.push({ key: entry.key, type: entry.type, line: entry.startLine, missing })
        }
      } else {
        const missing = required.filter(f => isFieldMissing(entry.fields[f]))
        if (missing.length > 0) {
          issues.push({ key: entry.key, type: entry.type, line: entry.startLine, missing })
        }
      }
    }

    if (issues.length === 0) {
      return ToolResult.success(
        `Validation passed: all ${entries.length} entries in ${bibPath} have required fields.`,
        { issueCount: 0, entryCount: entries.length }
      )
    }

    const lines = [`Validation report for ${bibPath} (${entries.length} entries, ${issues.length} with issues):`, '']
    for (const issue of issues) {
      lines.push(`  - ${issue.key} (@${issue.type}, line ${issue.line}): missing ${issue.missing.join(', ')}`)
    }

    return ToolResult.success(lines.join('\n'), {
      issueCount: issues.length,
      entryCount: entries.length,
    })
  }

  /**
   * Find duplicate entries.
   */
  _dedupe(entries, bibPath) {
    const groups = findDuplicates(entries)

    if (groups.length === 0) {
      return ToolResult.success(
        `No duplicates found among ${entries.length} entries in ${bibPath}.`,
        { duplicateGroups: 0, entryCount: entries.length }
      )
    }

    const lines = [`Duplicate report for ${bibPath} (${groups.length} group(s)):`, '']
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      const keys = group.entries.map(e => e.key).join(', ')
      const reason = group.reason === 'doi' ? 'same DOI' : 'same title + year'
      lines.push(`  Group ${i + 1} (${reason}): ${keys}`)
    }

    return ToolResult.success(lines.join('\n'), {
      duplicateGroups: groups.length,
      entryCount: entries.length,
    })
  }

  /**
   * Find bib entries not cited in any .tex file.
   */
  async _findUnused(entries, bibPath, projectId, adapters) {
    const citedKeys = await this._collectCitations(projectId, adapters)
    const unused = entries.filter(e => !citedKeys.has(e.key))

    if (unused.length === 0) {
      return ToolResult.success(
        `All ${entries.length} entries in ${bibPath} are cited in .tex files.`,
        { unusedCount: 0, entryCount: entries.length }
      )
    }

    const lines = [`Unused entries in ${bibPath} (${unused.length} of ${entries.length}):`, '']
    for (const entry of unused) {
      const title = entry.fields.title ? ` — "${entry.fields.title}"` : ''
      lines.push(`  - ${entry.key} (@${entry.type}, line ${entry.startLine})${title}`)
    }

    lines.push('')
    lines.push('Note: Key matching is case-sensitive. Ensure citation keys in .tex files match .bib entries exactly.')

    return ToolResult.success(lines.join('\n'), {
      unusedCount: unused.length,
      entryCount: entries.length,
      unusedKeys: unused.map(e => e.key),
    })
  }

  /**
   * Find citations in .tex files with no matching bib entry.
   */
  async _findMissing(entries, bibPath, projectId, adapters) {
    const citedKeys = await this._collectCitations(projectId, adapters)
    const bibKeySet = new Set(entries.map(e => e.key))
    const missing = []

    for (const [key, locations] of citedKeys) {
      if (!bibKeySet.has(key)) {
        missing.push({ key, locations })
      }
    }

    if (missing.length === 0) {
      return ToolResult.success(
        `All cited keys have matching entries in ${bibPath}.`,
        { missingCount: 0 }
      )
    }

    const lines = [`Missing bib entries (${missing.length} key(s) cited but not in ${bibPath}):`, '']
    for (const { key, locations } of missing) {
      const locs = locations.map(l => `${l.file}:${l.line}`).join(', ')
      lines.push(`  - ${key} (cited in: ${locs})`)
    }

    return ToolResult.success(lines.join('\n'), {
      missingCount: missing.length,
      missingKeys: missing.map(m => m.key),
    })
  }

  /**
   * Preview normalization changes.
   */
  _normalize(entries, bibPath) {
    const changes = []

    for (const entry of entries) {
      const normalized = normalizeBibEntry(entry)
      const diffs = []

      for (const [field, newVal] of Object.entries(normalized.fields)) {
        const oldVal = entry.fields[field]
        if (oldVal !== newVal) {
          diffs.push({ field, from: oldVal, to: newVal })
        }
      }

      if (diffs.length > 0) {
        changes.push({ key: entry.key, diffs })
      }
    }

    if (changes.length === 0) {
      return ToolResult.success(
        `All ${entries.length} entries in ${bibPath} are already normalized.`,
        { changeCount: 0, entryCount: entries.length }
      )
    }

    const lines = [`Normalization preview for ${bibPath} (${changes.length} entries would change):`, '']
    for (const { key, diffs } of changes) {
      lines.push(`  ${key}:`)
      for (const d of diffs) {
        lines.push(`    ${d.field}: "${d.from}" -> "${d.to}"`)
      }
    }

    return ToolResult.success(lines.join('\n'), {
      changeCount: changes.length,
      entryCount: entries.length,
    })
  }

  /**
   * Preview sorted entry order.
   */
  _sort(entries, bibPath, args) {
    const sortBy = args.sort_by || 'key'
    const sorted = sortEntries(entries, sortBy)
    const currentOrder = entries.map(e => e.key)
    const newOrder = sorted.map(e => e.key)

    // Check if already sorted
    const alreadySorted = currentOrder.every((k, i) => k === newOrder[i])
    if (alreadySorted) {
      return ToolResult.success(
        `Entries in ${bibPath} are already sorted by ${sortBy}.`,
        { alreadySorted: true, entryCount: entries.length }
      )
    }

    const lines = [`Sort preview for ${bibPath} (${entries.length} entries, sorted by ${sortBy}):`, '']
    for (let i = 0; i < newOrder.length; i++) {
      const moved = currentOrder[i] !== newOrder[i] ? ' *' : ''
      lines.push(`  ${String(i + 1).padStart(3)}. ${newOrder[i]}${moved}`)
    }
    lines.push('', '(* = position changed)')

    return ToolResult.success(lines.join('\n'), {
      alreadySorted: false,
      entryCount: entries.length,
      newOrder,
    })
  }
}

export function createBibManageTool() {
  return new BibManageTool()
}

export default BibManageTool
