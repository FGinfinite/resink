import path from 'node:path'
import { buildExclusionZones, isInZone, isCommented } from './latex-refs.js'

const DEFAULT_OPTIONS = {
  followInputs: true,
  maxDepth: 5,
  maxFiles: 50,
  maxTotalChars: 500000,
}

/**
 * Recursively resolve \input and \include directives in a LaTeX project.
 *
 * @param {string} entryPath - Path to the entry .tex file (e.g., 'main.tex')
 * @param {(filePath: string) => Promise<{ content: string, docId: string } | null>} readFn
 * @param {object} [options]
 * @param {boolean} [options.followInputs=true] - Whether to recursively follow \input/\include
 * @param {number} [options.maxDepth=5] - Maximum recursion depth
 * @returns {Promise<{ files: Array<{ path: string, content: string, docId: string }>, tree: object, errors: string[] }>}
 */
export async function resolveInputs(entryPath, readFn, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const visiting = new Set()   // recursion stack for true cycle detection
  const resolved = new Map()   // cache: filePath -> readFn result (avoids re-reading)
  const files = new Map()      // deduplicated file entries
  const errors = []
  const counters = { fileCount: 0, totalChars: 0 }

  const normalizedEntry = normalizePath(entryPath)
  if (!normalizedEntry) {
    return { files: [], tree: { path: entryPath, children: [] }, errors: [`Invalid entry path: ${entryPath}`] }
  }
  const tree = await resolve(normalizedEntry, readFn, opts, visiting, resolved, files, errors, 0, counters)

  return { files: Array.from(files.values()), tree, errors }
}

/**
 * Normalize a LaTeX file path: resolve relative segments and ensure leading '/'.
 * Rejects paths that traverse outside the project root.
 * @param {string} filePath
 * @returns {string|null} Normalized path or null if path traversal detected
 */
function normalizePath(filePath) {
  // Strip leading '/' to normalize as a relative path, so that '..' segments
  // escaping the project root are preserved rather than absorbed (POSIX treats
  // '/../../x' as '/x', which hides the traversal).
  const stripped = filePath.startsWith('/') ? filePath.slice(1) : filePath
  const normalized = path.posix.normalize(stripped)
  // Reject paths that escape the project root
  if (normalized.split('/').includes('..')) {
    return null
  }
  return '/' + normalized
}

/**
 * Ensure a file path has a .tex extension.
 */
function ensureTexExtension(filePath) {
  return path.extname(filePath) ? filePath : filePath + '.tex'
}

/**
 * Recursively resolve a single file and its \input/\include references.
 * Uses `visiting` (recursion stack) for true cycle detection and `resolved`
 * as a read cache to avoid redundant I/O.
 */
async function resolve(filePath, readFn, opts, visiting, resolved, files, errors, depth, counters) {
  const node = { path: filePath, children: [] }

  if (visiting.has(filePath)) {
    errors.push(`Circular reference: ${filePath}`)
    return node
  }

  // Check total file count limit
  if (counters.fileCount >= opts.maxFiles) {
    errors.push(`Max file count (${opts.maxFiles}) exceeded, skipping: ${filePath}`)
    return node
  }

  // Check total character count limit
  if (counters.totalChars >= opts.maxTotalChars) {
    errors.push(`Max total characters (${opts.maxTotalChars}) exceeded, skipping: ${filePath}`)
    return node
  }

  // Read file (from cache or fresh)
  let result
  let readError = false
  if (resolved.has(filePath)) {
    result = resolved.get(filePath)
  } else {
    try {
      result = await readFn(filePath)
    } catch (err) {
      errors.push(`Error reading ${filePath}: ${err.message || err}`)
      readError = true
      result = null
    }
    resolved.set(filePath, result)
  }

  if (!result && !readError) {
    errors.push(`File not found: ${filePath}`)
    return node
  }

  if (!result) {
    return node
  }

  // Add to files list only once
  if (!files.has(filePath)) {
    files.set(filePath, { path: filePath, content: result.content, docId: result.docId })
    counters.fileCount++
    counters.totalChars += result.content.length
  }

  if (!opts.followInputs) return node

  if (depth >= opts.maxDepth) {
    errors.push(`Max depth exceeded at: ${filePath}`)
    return node
  }

  visiting.add(filePath)

  const refs = extractInputReferences(result.content)
  // Use relative dir (without leading '/') so that path.posix.join does not
  // absorb '..' segments that would escape the project root.
  const relDir = filePath.startsWith('/') ? filePath.slice(1) : filePath
  const dir = path.posix.dirname(relDir)

  for (const ref of refs) {
    const withExt = ensureTexExtension(ref)
    const joined = dir ? path.posix.join(dir, withExt) : withExt
    const resolvedPath = normalizePath(joined)
    if (!resolvedPath) {
      errors.push(`Path traversal rejected: ${ref} (from ${filePath})`)
      continue
    }
    const child = await resolve(resolvedPath, readFn, opts, visiting, resolved, files, errors, depth + 1, counters)
    node.children.push(child)
  }

  visiting.delete(filePath)

  return node
}

/**
 * Extract \input{} and \include{} references from LaTeX content.
 * Handles multiple references on the same line.
 * Tolerates whitespace between command and opening brace.
 * Excludes references inside comments (unescaped %) and verbatim environments.
 */
export function extractInputReferences(content) {
  const refs = []
  const zones = buildExclusionZones(content)
  const pattern = /\\(input|include)\s*\{([^}]+)\}/g
  let match
  while ((match = pattern.exec(content)) !== null) {
    if (isCommented(content, match.index)) continue
    if (isInZone(zones, match.index)) continue
    refs.push(match[2].trim())
  }
  return refs
}
