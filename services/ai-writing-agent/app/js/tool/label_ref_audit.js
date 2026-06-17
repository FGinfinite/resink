import path from 'node:path'
import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { resolveInputs } from '../util/input-resolver.js'
import { extractLabels, extractRefs, extractCitations, extractBibResources } from '../util/latex-refs.js'
import { parseBibFile } from '../util/bibtex.js'

/**
 * Environment patterns used to infer expected label prefixes.
 * Maps environment names to the conventional label prefix.
 */
const ENV_PREFIX_MAP = {
  figure: 'fig:',
  table: 'tab:',
  equation: 'eq:',
  align: 'eq:',
  eqnarray: 'eq:',
  lstlisting: 'lst:',
  algorithm: 'alg:',
}

/**
 * Sectioning commands that conventionally use sec: or ch: prefixes.
 */
const SECTION_COMMANDS = new Set([
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph',
])

/**
 * All recognised label prefixes (conventional).
 */
const KNOWN_PREFIXES = ['fig:', 'tab:', 'sec:', 'eq:', 'ch:', 'lst:', 'alg:']

const labelRefAuditSchema = z.object({
  entry_file: z
    .string()
    .optional()
    .default('main.tex')
    .describe('Entry .tex file path (default: main.tex)'),
  follow_inputs: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to follow \\input/\\include directives'),
  check_types: z
    .array(z.enum(['labels', 'refs', 'cites', 'all']))
    .optional()
    .default(['all'])
    .describe('Types of checks to perform (default: all)'),
})

/**
 * Tool for auditing cross-references, labels and citations in a LaTeX project.
 * Detects duplicate labels, naming convention violations, undefined/unused
 * references, and missing citation keys.
 */
export class LabelRefAuditTool extends Tool {
  constructor() {
    super({
      name: 'label_ref_audit',
      description: `Audit cross-references, labels and citations across a LaTeX project.
Checks for:
- Duplicate labels (same key defined in multiple places)
- Label naming convention violations (fig:, tab:, sec:, eq:, ch:, lst:, alg:)
- Undefined references (\\ref to non-existent \\label)
- Unused labels (\\label never referenced by any \\ref)
- Missing citation keys (\\cite to keys not in any .bib file)
Returns a detailed report with locations and a summary.`,
      parameters: labelRefAuditSchema,
    })
  }

  /**
   * Execute the label_ref_audit tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { entry_file: entryFile, follow_inputs: followInputs, check_types: checkTypes } = args
    const { adapters, projectId } = context

    if (!adapters.project || !adapters.document) {
      return ToolResult.error(
        'Project and Document adapters are required. Cannot audit references.'
      )
    }

    const checkAll = checkTypes.includes('all')
    const checkLabels = checkAll || checkTypes.includes('labels')
    const checkRefs = checkAll || checkTypes.includes('refs')
    const checkCites = checkAll || checkTypes.includes('cites')

    // Build readFn adapter for resolveInputs
    const readFn = async (filePath) => {
      const normalizedPath = filePath.startsWith('/') ? filePath : '/' + filePath
      const docId = await adapters.project.resolvePathToDocId(projectId, normalizedPath)
      if (!docId) return null
      try {
        const { content } = await adapters.document.getDocumentContent(projectId, docId)
        return { content, docId }
      } catch {
        return null
      }
    }

    // 1. Resolve the input tree
    const resolved = await resolveInputs(entryFile, readFn, { followInputs })

    if (resolved.files.length === 0) {
      return ToolResult.error(
        `Could not read entry file: "${entryFile}". Use list_files to check available files.`
      )
    }

    // 2. Extract labels, refs, and citations from all files
    const allLabels = []   // { key, file, line }
    const allRefs = []     // { key, command, file, line }
    const allCitations = [] // { keys[], command, file, line }
    const allBibResources = [] // { path, command, file, line }

    for (const file of resolved.files) {
      allLabels.push(...extractLabels(file.content, file.path))
      allRefs.push(...extractRefs(file.content, file.path))
      allCitations.push(...extractCitations(file.content, file.path))
      allBibResources.push(...extractBibResources(file.content, file.path))
    }

    // 3. If checking cites, load .bib files and collect all bib keys
    const bibKeys = new Set()
    const bibFileNames = []
    if (checkCites) {
      // Collect unique bib paths from \bibliography and \addbibresource
      const bibPaths = new Set()
      for (const res of allBibResources) {
        // \bibliography can have comma-separated paths
        const paths = res.path.split(',').map(p => p.trim()).filter(Boolean)
        const resDir = path.posix.dirname(res.file)
        for (let p of paths) {
          // Resolve relative to the file that contains the command
          if (!p.startsWith('/')) {
            p = path.posix.normalize(path.posix.join(resDir, p))
          }
          // Check for path traversal
          if (p.split('/').some(seg => seg === '..')) {
            continue
          }
          bibPaths.add(p)
        }
      }

      for (const bibPath of bibPaths) {
        // Ensure .bib extension
        const withExt = bibPath.endsWith('.bib') ? bibPath : bibPath + '.bib'
        const normalizedBib = withExt.startsWith('/') ? withExt : '/' + withExt
        bibFileNames.push(normalizedBib)

        const bibResult = await readFn(normalizedBib)
        if (bibResult) {
          const entries = parseBibFile(bibResult.content)
          for (const entry of entries) {
            bibKeys.add(entry.key)
          }
        }
      }
    }

    // 4. Cross-compare and build issues
    const labelIssues = []
    const refIssues = []
    const citeIssues = []

    // --- Labels audit ---
    if (checkLabels) {
      // Duplicate labels
      const labelMap = new Map() // key -> [{ file, line }]
      for (const label of allLabels) {
        if (!labelMap.has(label.key)) labelMap.set(label.key, [])
        labelMap.get(label.key).push({ file: label.file, line: label.line })
      }
      for (const [key, locations] of labelMap) {
        if (locations.length > 1) {
          const locs = locations.map(l => `${l.file}:${l.line}`).join(' and ')
          labelIssues.push(`DUPLICATE: Label "${key}" defined at ${locs}`)
        }
      }

      // Suspicious naming: labels associated with environments that don't follow convention
      for (const file of resolved.files) {
        checkLabelNaming(file.content, file.path, labelIssues)
      }
    }

    // --- Refs audit ---
    if (checkRefs) {
      const labelKeySet = new Set(allLabels.map(l => l.key))
      const referencedKeys = new Set(allRefs.map(r => r.key))

      // Undefined references
      for (const ref of allRefs) {
        if (!labelKeySet.has(ref.key)) {
          refIssues.push(
            `UNDEFINED: \\${ref.command}{${ref.key}} at ${ref.file}:${ref.line} -- no matching \\label found`
          )
        }
      }

      // Unused labels
      for (const label of allLabels) {
        if (!referencedKeys.has(label.key)) {
          refIssues.push(
            `UNUSED: \\label{${label.key}} at ${label.file}:${label.line} -- never referenced`
          )
        }
      }
    }

    // --- Cites audit ---
    if (checkCites) {
      for (const cite of allCitations) {
        for (const key of cite.keys) {
          if (!bibKeys.has(key)) {
            const bibFiles = bibFileNames.length > 0 ? bibFileNames.join(', ') : '(no .bib files found)'
            citeIssues.push(
              `MISSING: \\${cite.command}{${key}} at ${cite.file}:${cite.line} -- not found in ${bibFiles}`
            )
          }
        }
      }
    }

    // 5. Format output
    const output = formatReport(labelIssues, refIssues, citeIssues, checkLabels, checkRefs, checkCites, resolved.errors)

    const totalIssues = labelIssues.length + refIssues.length + citeIssues.length

    return ToolResult.success(output, {
      labelIssueCount: labelIssues.length,
      refIssueCount: refIssues.length,
      citeIssueCount: citeIssues.length,
      totalIssues,
    })
  }
}

/**
 * Check label naming conventions within a file.
 * Only flags labels that are associated with a known environment or sectioning command
 * but don't use the expected prefix.
 *
 * @param {string} content - File content
 * @param {string} filePath - File path
 * @param {Array<string>} issues - Issues array to push to
 */
function checkLabelNaming(content, filePath, issues) {
  // Use extractLabels to get labels already filtered by isExcluded (comments + verbatim)
  const labels = extractLabels(content, filePath)
  const lines = content.split('\n')

  for (const label of labels) {
    const labelKey = label.key
    const lineIdx = label.line - 1 // convert 1-based line to 0-based index

    // Skip if already uses a known prefix
    if (KNOWN_PREFIXES.some(p => labelKey.startsWith(p))) continue

    // Look for the context: check current and preceding lines for environment or sectioning command
    const expectedPrefix = findExpectedPrefix(lines, lineIdx)
    if (expectedPrefix) {
      let suggestedKey
      if (labelKey.includes(':')) {
        // Replace existing prefix
        suggestedKey = expectedPrefix + labelKey.split(':').slice(1).join(':')
      } else {
        suggestedKey = expectedPrefix + labelKey
      }
      issues.push(
        `NAMING: Label "${labelKey}" at ${filePath}:${label.line} does not follow convention (suggest: ${suggestedKey})`
      )
    }
  }
}

/**
 * Look at the current line and a few preceding lines to determine what
 * environment or sectioning context a label is in, and return the expected prefix.
 *
 * @param {string[]} lines - All lines in the file
 * @param {number} labelLineIdx - Index of the line containing \label
 * @returns {string|null} - Expected prefix or null if not determinable
 */
function findExpectedPrefix(lines, labelLineIdx) {
  // Search current line and up to 8 preceding lines for context
  const searchStart = Math.max(0, labelLineIdx - 8)

  for (let i = labelLineIdx; i >= searchStart; i--) {
    const line = lines[i]

    // Check for \begin{environment}
    const envMatch = /\\begin\{(\w+)\*?\}/.exec(line)
    if (envMatch) {
      const envName = envMatch[1]
      if (ENV_PREFIX_MAP[envName]) return ENV_PREFIX_MAP[envName]
    }

    // Check for sectioning commands
    const secMatch = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{/.exec(line)
    if (secMatch) {
      const cmd = secMatch[1]
      if (cmd === 'chapter') return 'ch:'
      if (SECTION_COMMANDS.has(cmd)) return 'sec:'
    }
  }

  return null
}

/**
 * Format the full audit report.
 */
function formatReport(labelIssues, refIssues, citeIssues, checkLabels, checkRefs, checkCites, resolveErrors) {
  const lines = []

  lines.push('Cross-Reference Audit Report')
  lines.push('=============================')

  if (checkLabels) {
    lines.push('')
    lines.push('## Label Issues')
    if (labelIssues.length === 0) {
      lines.push('No label issues found.')
    } else {
      for (const issue of labelIssues) {
        lines.push(`- ${issue}`)
      }
    }
  }

  if (checkRefs) {
    lines.push('')
    lines.push('## Reference Issues')
    if (refIssues.length === 0) {
      lines.push('No reference issues found.')
    } else {
      for (const issue of refIssues) {
        lines.push(`- ${issue}`)
      }
    }
  }

  if (checkCites) {
    lines.push('')
    lines.push('## Citation Issues')
    if (citeIssues.length === 0) {
      lines.push('No citation issues found.')
    } else {
      for (const issue of citeIssues) {
        lines.push(`- ${issue}`)
      }
    }
  }

  // Summary line
  const summaryParts = []
  if (checkLabels) summaryParts.push(`${labelIssues.length} label issue(s)`)
  if (checkRefs) {
    const undefinedCount = refIssues.filter(i => i.startsWith('UNDEFINED')).length
    const unusedCount = refIssues.filter(i => i.startsWith('UNUSED')).length
    summaryParts.push(`${undefinedCount} undefined ref(s)`)
    summaryParts.push(`${unusedCount} unused label(s)`)
  }
  if (checkCites) summaryParts.push(`${citeIssues.length} missing citation(s)`)

  lines.push('')
  lines.push(`Summary: ${summaryParts.join(', ')}`)

  // Resolution errors from input-resolver
  if (resolveErrors.length > 0) {
    lines.push('')
    lines.push('Resolution errors:')
    for (const err of resolveErrors) {
      lines.push(`  - ${err}`)
    }
  }

  return lines.join('\n')
}

export function createLabelRefAuditTool() {
  return new LabelRefAuditTool()
}

export default LabelRefAuditTool
