import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { resolveInputs } from '../util/input-resolver.js'
import { extractOutlineEntries } from '../util/outline.js'
import { extractCitations } from '../util/latex-refs.js'

const METRICS_ENUM = [
  'word_count',
  'equation_count',
  'figure_count',
  'table_count',
  'citation_count',
  'todo_count',
]

const docStructureMapSchema = z.object({
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
  metrics: z
    .array(z.enum(METRICS_ENUM))
    .optional()
    .default([])
    .describe('Optional metrics to compute per section'),
})

/**
 * Tool for analysing the structural outline of a LaTeX project.
 * Resolves \input/\include trees and extracts sectioning hierarchy
 * with optional per-section metrics (word count, equations, figures, etc.).
 */
export class DocStructureMapTool extends Tool {
  constructor() {
    super({
      name: 'doc_structure_map',
      description: `Analyse the structure of a LaTeX project starting from an entry file.
Resolves \\input/\\include trees, extracts sectioning hierarchy across all files,
and optionally computes per-section metrics (word_count, equation_count, figure_count,
table_count, citation_count, todo_count).
Returns a tree-like outline with file boundaries, section ranges, metrics, and
imbalance warnings when sections deviate significantly from average word count.`,
      parameters: docStructureMapSchema,
    })
  }

  /**
   * Execute the doc_structure_map tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @returns {Promise<ToolResult>}
   */
  async execute(args, context) {
    const { entry_file: entryFile, follow_inputs: followInputs, metrics } = args
    const { adapters, projectId } = context

    if (!adapters.project || !adapters.document) {
      return ToolResult.error(
        'Project and Document adapters are required. Cannot analyse structure.'
      )
    }

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

    const wantMetrics = metrics.length > 0

    // 2. Extract outline entries per file
    const fileEntries = [] // { path, content, entries: [...] | null }
    for (const file of resolved.files) {
      if (!file.path.endsWith('.tex')) continue
      const entries = extractOutlineEntries(file.content)
      fileEntries.push({ path: file.path, content: file.content, entries })
    }

    // 3. Build a flat global section list with line ranges
    const globalSections = buildGlobalSections(fileEntries)

    // 4. Compute per-section metrics if requested
    if (wantMetrics) {
      // Build a lines-by-file map to compute slices on demand (avoids O(n²) storage)
      const linesByFile = new Map()
      for (const file of fileEntries) {
        linesByFile.set(file.path, file.content.split('\n'))
      }
      for (const sec of globalSections) {
        const lines = linesByFile.get(sec.filePath)
        if (!lines) continue
        const startIdx = Math.max(0, sec.startLine - 1)
        const endIdx = Math.min(lines.length, sec.endLine)
        const contentSlice = lines.slice(startIdx, endIdx).join('\n')
        sec.metrics = computeMetrics(contentSlice, sec.filePath, metrics)
      }
    }

    // 5. Compute global summary
    const texFiles = resolved.files.filter(f => f.path.endsWith('.tex'))
    const totalFiles = texFiles.length
    const totalSections = globalSections.length

    // For totalWords, compute from raw content to avoid double-counting from overlapping sections
    let totalWords = 0
    if (wantMetrics && metrics.includes('word_count')) {
      for (const file of texFiles) {
        totalWords += countWords(file.content)
      }
    }

    // 6. Imbalance warnings — only compare leaf sections (those without sub-sections)
    const warnings = []
    if (wantMetrics && metrics.includes('word_count') && totalSections > 1) {
      // A section is a "leaf" if no other section in the same file has a higher level within its range
      const leafSections = globalSections.filter(sec => {
        return !globalSections.some(other =>
          other !== sec &&
          other.filePath === sec.filePath &&
          other.level > sec.level &&
          other.startLine >= sec.startLine &&
          other.endLine <= sec.endLine
        )
      })

      if (leafSections.length > 1) {
        const leafWordSum = leafSections.reduce((sum, s) => sum + (s.metrics?.word_count ?? 0), 0)
        const avgWords = leafWordSum / leafSections.length
        for (const sec of leafSections) {
          const wc = sec.metrics?.word_count ?? 0
          if (wc > avgWords * 2.5) {
            sec.warning = 'above average'
            warnings.push(`"${sec.title}" (${wc} words) is above average (${Math.round(avgWords)})`)
          } else if (wc < avgWords * 0.3) {
            sec.warning = 'below average'
            warnings.push(`"${sec.title}" (${wc} words) is below average (${Math.round(avgWords)})`)
          }
        }
      }
    }

    // 7. Format output
    const output = formatOutput(
      resolved.tree,
      fileEntries,
      globalSections,
      wantMetrics,
      metrics,
      totalFiles,
      totalSections,
      totalWords,
      warnings,
      resolved.errors
    )

    return ToolResult.success(output, {
      fileCount: totalFiles,
      sectionCount: totalSections,
      totalWords: wantMetrics && metrics.includes('word_count') ? totalWords : undefined,
      warningCount: warnings.length,
    })
  }
}

/**
 * Build a flat list of global sections with line ranges (no content stored).
 * Content slices are computed on demand during metrics calculation.
 */
function buildGlobalSections(fileEntries) {
  const sections = []

  for (const file of fileEntries) {
    if (!file.entries) continue

    for (const entry of file.entries) {
      sections.push({
        filePath: file.path,
        level: entry.level,
        command: entry.command,
        title: entry.title,
        startLine: entry.startLine,
        endLine: entry.endLine,
        metrics: null,
        warning: null,
      })
    }
  }

  return sections
}

/**
 * Compute requested metrics on a content slice.
 */
function computeMetrics(content, filePath, requestedMetrics) {
  const result = {}

  for (const metric of requestedMetrics) {
    switch (metric) {
      case 'word_count':
        result.word_count = countWords(content)
        break
      case 'equation_count':
        result.equation_count = countEquations(content)
        break
      case 'figure_count':
        result.figure_count = countEnvironment(content, 'figure')
        break
      case 'table_count':
        result.table_count = countEnvironment(content, 'table')
        break
      case 'citation_count':
        result.citation_count = countCitations(content, filePath)
        break
      case 'todo_count':
        result.todo_count = countTodos(content)
        break
    }
  }

  return result
}

/**
 * Count words after stripping LaTeX commands.
 */
function countWords(content) {
  // Remove \begin{...} and \end{...}
  let text = content.replace(/\\(begin|end)\{[^}]*\}/g, ' ')
  // Remove \command{...} patterns (single-arg commands), loop to handle nesting
  let prev
  do {
    prev = text
    text = text.replace(/\\[a-zA-Z]+\{[^{}]*\}/g, ' ')
  } while (text !== prev)
  // Remove remaining \commands without braces
  text = text.replace(/\\[a-zA-Z]+/g, ' ')
  // Remove braces, brackets, dollar signs
  text = text.replace(/[{}[\]$]/g, ' ')
  // Remove comment lines (unescaped % only; \% is a literal percent sign)
  // Replace escaped backslashes temporarily to handle \\% correctly
  text = text.replace(/\\\\/g, '\x00\x00')
  text = text.replace(/(^|[^\x00\\])%.*/gm, '$1')
  text = text.replace(/\x00\x00/g, '\\\\')
  // Split by whitespace and count non-empty tokens
  const words = text.split(/\s+/).filter(w => w.length > 0)
  return words.length
}

/**
 * Count equation environments and display-math delimiters.
 */
function countEquations(content) {
  let count = 0
  // \begin{equation}, \begin{align}, \begin{eqnarray} (including starred variants)
  const envPattern = /\\begin\{(equation|align|eqnarray|gather|multline|flalign|alignat|displaymath)\*?\}/g
  while (envPattern.exec(content) !== null) {
    count++
  }
  // $$ ... $$ pairs (display math)
  const doubleDollarMatches = content.match(/\$\$[\s\S]*?\$\$/g)
  if (doubleDollarMatches) {
    count += doubleDollarMatches.length
  }
  // \[ ... \] (display math)
  const bracketMath = content.match(/\\\[/g)
  if (bracketMath) {
    count += bracketMath.length
  }
  return count
}

/**
 * Count occurrences of a specific LaTeX environment.
 */
function countEnvironment(content, envName) {
  const pattern = new RegExp(`\\\\begin\\{${envName}\\*?\\}`, 'g')
  const matches = content.match(pattern)
  return matches ? matches.length : 0
}

/**
 * Count total citation keys using extractCitations from latex-refs.js.
 */
function countCitations(content, filePath) {
  const citations = extractCitations(content, filePath)
  let total = 0
  for (const cite of citations) {
    total += cite.keys.length
  }
  return total
}

/**
 * Count TODO/FIXME markers.
 */
function countTodos(content) {
  const pattern = /% *TODO|\\todo\{|FIXME/gi
  const matches = content.match(pattern)
  return matches ? matches.length : 0
}

/**
 * Format the final output as a tree-like text with summary and warnings.
 */
function formatOutput(
  tree,
  fileEntries,
  globalSections,
  wantMetrics,
  metrics,
  totalFiles,
  totalSections,
  totalWords,
  warnings,
  resolveErrors
) {
  const lines = []

  // Build a map from filePath to sections for quick lookup
  const sectionsByFile = new Map()
  for (const sec of globalSections) {
    if (!sectionsByFile.has(sec.filePath)) {
      sectionsByFile.set(sec.filePath, [])
    }
    sectionsByFile.get(sec.filePath).push(sec)
  }

  // Render the tree recursively
  renderTreeNode(tree, lines, sectionsByFile, wantMetrics, metrics, 0)

  // Summary
  lines.push('')
  const summaryParts = [`${totalFiles} file(s)`, `${totalSections} section(s)`]
  if (wantMetrics && metrics.includes('word_count')) {
    summaryParts.push(`${totalWords} words total`)
  }
  lines.push(`Summary: ${summaryParts.join(', ')}`)

  // Warnings
  if (warnings.length > 0) {
    lines.push(`Warnings: ${warnings.length} imbalanced section(s) (note: cross-file sub-sections are not tracked)`)
    for (const w of warnings) {
      lines.push(`  - ${w}`)
    }
  }

  // Resolution errors
  if (resolveErrors.length > 0) {
    lines.push('')
    lines.push('Resolution errors:')
    for (const err of resolveErrors) {
      lines.push(`  - ${err}`)
    }
  }

  return lines.join('\n')
}

/**
 * Recursively render a tree node (file + its sections + children).
 */
function renderTreeNode(node, lines, sectionsByFile, wantMetrics, metrics, depth) {
  const indent = '  '.repeat(depth)
  const displayPath = node.path.startsWith('/') ? node.path.slice(1) : node.path

  lines.push(`${indent}${displayPath}`)

  // Render sections for this file
  const sections = sectionsByFile.get(node.path) || []
  for (const sec of sections) {
    const secIndent = '  '.repeat(depth + 1)
    let line = `${secIndent}\\${sec.command}{${sec.title}} (L${sec.startLine}-L${sec.endLine}`

    if (wantMetrics && sec.metrics) {
      const metricParts = []
      for (const m of metrics) {
        if (sec.metrics[m] !== undefined) {
          metricParts.push(formatMetric(m, sec.metrics[m]))
        }
      }
      if (metricParts.length > 0) {
        line += `, ${metricParts.join(', ')}`
      }
    }

    line += ')'

    if (sec.warning) {
      line += ` ⚠ ${sec.warning}`
    }

    lines.push(line)
  }

  // Render children (input/include files)
  for (const child of node.children) {
    renderTreeNode(child, lines, sectionsByFile, wantMetrics, metrics, depth + 1)
  }
}

/**
 * Format a single metric for display.
 */
function formatMetric(name, value) {
  switch (name) {
    case 'word_count':
      return `${value} words`
    case 'equation_count':
      return `${value} eq`
    case 'figure_count':
      return `${value} fig`
    case 'table_count':
      return `${value} tbl`
    case 'citation_count':
      return `${value} cite`
    case 'todo_count':
      return `${value} todo`
    default:
      return `${value}`
  }
}

export function createDocStructureMapTool() {
  return new DocStructureMapTool()
}

export default DocStructureMapTool
