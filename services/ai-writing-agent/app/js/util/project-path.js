import path from 'node:path'

const ENCODED_PATH_RE = /%(?:2e|2f|5c)/i

export function validateProjectPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { error: 'Path is required.' }
  }
  if (rawPath.includes('\\')) {
    return { error: 'Invalid path: backslashes are not allowed.' }
  }
  if (ENCODED_PATH_RE.test(rawPath)) {
    return { error: 'Invalid path: encoded path characters are not allowed.' }
  }
  const stripped = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
  const normalized = path.posix.normalize(stripped)
  if (normalized.split('/').includes('..')) {
    return { error: 'Invalid path: ".." segments are not allowed.' }
  }
  return { path: '/' + normalized }
}

export function normalizeProjectPath(rawPath) {
  const result = validateProjectPath(rawPath)
  if (result.error) {
    throw new Error(result.error)
  }
  return result.path
}

export function projectPathToWorkspaceRelative(projectPath) {
  const normalizedPath = normalizeProjectPath(projectPath)
  return normalizedPath.slice(1)
}

export function resolveWorkspacePath(workspaceRoot, projectPath) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new Error('Workspace root is required.')
  }
  const relativePath = projectPathToWorkspaceRelative(projectPath)
  const absolutePath = path.resolve(workspaceRoot, relativePath)
  const relativeToRoot = path.relative(path.resolve(workspaceRoot), absolutePath)
  if (
    relativeToRoot === '' ||
    relativeToRoot.startsWith('..') ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error('Resolved path is outside workspace root.')
  }
  return absolutePath
}
