import {
  buildDependencyRequest,
  parsePep723ScriptMetadata,
  parsePyprojectToml,
  parseSkillJson,
  sourceFile,
} from './DependencyMetadata.js'

export class SkillDependencyResolver {
  constructor(options = {}) {
    this.skillRegistry = options.skillRegistry
  }

  async resolve(skillName, options = {}) {
    const skill = options.skill || this.skillRegistry?.get?.(skillName)
    if (!skill) return undefined

    const sources = []
    const packages = []
    const findings = []
    let requestedPythonVersion = null
    let requestedNetworkPolicy = 'none'
    let requestedEnvironmentKey = null

    const skillJson = await this.skillRegistry.readPackageFile?.(skillName, 'skill.json')
    if (skillJson) {
      sources.push(sourceFile('skill.json', skillJson.content, 'skill-json'))
      try {
        const parsed = parseSkillJson(skillJson.content)
        packages.push(...parsed.packages)
        findings.push(...parsed.findings)
        requestedPythonVersion = parsed.python?.pythonVersion || requestedPythonVersion
        requestedNetworkPolicy = parsed.python?.network || requestedNetworkPolicy
        requestedEnvironmentKey = parsed.python?.approvedSnapshot || requestedEnvironmentKey
      } catch (error) {
        findings.push({
          code: 'INVALID_SKILL_JSON',
          severity: 'high',
          message: `skill.json could not be parsed: ${error.message}`,
        })
      }
    }

    const pyproject = await this.skillRegistry.readPackageFile?.(skillName, 'pyproject.toml')
    if (pyproject) {
      sources.push(sourceFile('pyproject.toml', pyproject.content, 'pyproject'))
      try {
        const parsed = parsePyprojectToml(pyproject.content)
        packages.push(...parsed.packages)
        findings.push(...parsed.findings)
        requestedPythonVersion = parsed.requestedPythonVersion || requestedPythonVersion
      } catch (error) {
        findings.push({
          code: 'INVALID_PYPROJECT',
          severity: 'high',
          message: `pyproject.toml could not be parsed: ${error.message}`,
        })
      }
    }

    const uvLock = await this.skillRegistry.readPackageFile?.(skillName, 'uv.lock')
    if (uvLock) {
      sources.push(sourceFile('uv.lock', uvLock.content, 'uv-lock'))
    }

    for (const script of skill.scripts || []) {
      const loaded = await this.skillRegistry.readScript?.(skillName, script.name)
      if (!loaded?.content) continue
      const parsed = parsePep723ScriptMetadata(loaded.content)
      if (!parsed.found) continue
      sources.push(sourceFile(loaded.relativePath, loaded.content, 'pep723'))
      packages.push(...parsed.packages)
      findings.push(...parsed.findings.map(finding => ({
        ...finding,
        scriptPath: loaded.relativePath,
      })))
      requestedPythonVersion = parsed.requestedPythonVersion || requestedPythonVersion
    }

    if (!sources.length && !packages.length) {
      return {
        required: false,
        skillName,
        status: 'none',
        packages: [],
        policyFindings: [],
        sourceFiles: [],
      }
    }

    const request = buildDependencyRequest({
      scope: 'skill',
      skillName,
      sourceFiles: sources,
      requestedPackages: packages,
      requestedPythonVersion,
      requestedNetworkPolicy,
      policyFindings: findings,
      environmentKey: requestedEnvironmentKey,
    })

    return {
      required: true,
      skillName,
      status: 'missing',
      environmentId: null,
      requestedEnvironmentKey,
      dependencyRequest: request,
      packages: request.requestedPackages,
      policyFindings: request.policyFindings,
      sourceFiles: request.sourceFiles,
    }
  }
}

export default SkillDependencyResolver
