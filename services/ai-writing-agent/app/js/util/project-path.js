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
