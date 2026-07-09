import {
  buildDependencyRequest,
  parsePep723ScriptMetadata,
  parsePyprojectToml,
  sourceFile,
} from './DependencyMetadata.js'

const PYTHON_METADATA_FILES = new Set([
  'pyproject.toml',
  'uv.lock',
  '.python-version',
])

export class ProjectDependencyResolver {
  async resolveFromFiles(files = [], options = {}) {
    const sources = []
    const packages = []
    const findings = []
    let requestedPythonVersion = null

    for (const file of files) {
      const path = normalizeProjectPath(file.path)
      if (!path) continue
      const content = String(file.content || '')

      if (path === 'pyproject.toml') {
        const parsed = parsePyprojectToml(content)
        sources.push(sourceFile(path, content, 'pyproject'))
        packages.push(...parsed.packages)
        findings.push(...parsed.findings)
        requestedPythonVersion = parsed.requestedPythonVersion || requestedPythonVersion
      } else if (path === 'uv.lock') {
        sources.push(sourceFile(path, content, 'uv-lock'))
      } else if (path === '.python-version') {
        sources.push(sourceFile(path, content, 'python-version'))
        requestedPythonVersion = content.trim() || requestedPythonVersion
      } else if (path.endsWith('.py')) {
        const parsed = parsePep723ScriptMetadata(content)
        if (!parsed.found) continue
        sources.push(sourceFile(path, content, 'pep723'))
        packages.push(...parsed.packages)
        findings.push(...parsed.findings.map(finding => ({
          ...finding,
          scriptPath: path,
        })))
        requestedPythonVersion = parsed.requestedPythonVersion || requestedPythonVersion
      }
    }

    if (!sources.length) {
      return {
        required: false,
        status: 'none',
        packages: [],
        policyFindings: [],
        sourceFiles: [],
      }
    }

    const hasLock = sources.some(source => source.path === 'uv.lock')
    const request = buildDependencyRequest({
      scope: 'project',
      sourceFiles: sources,
      requestedPackages: packages,
      requestedPythonVersion,
      requestedNetworkPolicy: options.requestedNetworkPolicy || 'none',
      policyFindings: findings,
      environmentKey: options.environmentKey || null,
    })

    return {
      required: packages.length > 0 || sources.some(source => PYTHON_METADATA_FILES.has(source.path)),
      status: hasLock ? 'locked' : 'missing-lock',
      dependencyRequest: request,
      packages: request.requestedPackages,
      policyFindings: request.policyFindings,
      sourceFiles: request.sourceFiles,
    }
  }
}

function normalizeProjectPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.includes('\0') || rawPath.includes('\\')) return ''
  if (rawPath.startsWith('/') || rawPath === '..' || rawPath.startsWith('../')) return ''
  return rawPath.replace(/^\.\//, '')
}

export default ProjectDependencyResolver
