export class AgentPolicyPathError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = 'AgentPolicyPathError'
    this.code = 'AGENT_POLICY_DENIED'
    this.info = info
  }
}

export function assertPathAllowedByGlobs(path, globs, action = 'access') {
  const normalizedPath = normalizePolicyPath(path)
  const normalizedGlobs = normalizeGlobs(globs)
  if (normalizedGlobs.length === 0) return
  if (normalizedGlobs.some(glob => globMatchesPath(glob, normalizedPath))) {
    return
  }
  throw new AgentPolicyPathError(
    `Policy denied ${action} for "${normalizedPath}"`,
    {
      path: normalizedPath,
      globs: normalizedGlobs,
      action,
    }
  )
}

export function globMatchesPath(glob, path) {
  const normalizedGlob = normalizePolicyPath(glob)
  const normalizedPath = normalizePolicyPath(path)
  if (normalizedGlob === '**/*' || normalizedGlob === normalizedPath) return true
  if (normalizedGlob.startsWith('**/*.')) {
    return normalizedPath.endsWith(normalizedGlob.slice('**/*'.length))
  }
  if (normalizedGlob.endsWith('/**')) {
    const prefix = normalizedGlob.slice(0, -'/**'.length)
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  }
  if (normalizedGlob.includes('*')) {
    const escaped = normalizedGlob
      .split('*')
      .map(part => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
      .join('[^/]*')
    return new RegExp(`^${escaped}$`).test(normalizedPath)
  }
  return false
}

function normalizeGlobs(globs) {
  return Array.isArray(globs)
    ? globs.filter(glob => typeof glob === 'string' && glob.trim())
    : []
}

function normalizePolicyPath(path) {
  return String(path || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
}
