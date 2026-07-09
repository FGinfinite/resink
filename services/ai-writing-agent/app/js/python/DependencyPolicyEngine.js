const DEFAULT_ALLOWED_SOURCE_KINDS = ['index']
const DEFAULT_DENIED_SOURCE_KINDS = ['direct-url', 'vcs', 'local-path']
const DEFAULT_DENIED_RUNTIME_COMMANDS = [
  'pip',
  'pip3',
  'python -m pip',
  'python -m ensurepip',
  'uv add',
  'uv pip',
  'uv tool',
  'uv run',
  'uv sync',
  'poetry add',
  'poetry install',
  'conda install',
  'npm',
  'npx',
]

export class DependencyPolicyEngine {
  constructor(options = {}) {
    this.config = normalizePolicyConfig(options.config || {})
  }

  evaluateRequest(request = {}) {
    const packages = Array.isArray(request.requestedPackages)
      ? request.requestedPackages
      : []
    const findings = [...(request.policyFindings || [])]

    if (packages.length > this.config.maxPackageCount) {
      findings.push({
        code: 'PACKAGE_COUNT_LIMIT_EXCEEDED',
        severity: 'high',
        message: `Dependency request contains ${packages.length} packages; limit is ${this.config.maxPackageCount}.`,
      })
    }

    for (const pkg of packages) {
      const sourceKind = pkg.sourceHint || 'index'
      if (this.config.deniedSourceKinds.has(sourceKind)) {
        findings.push({
          code: 'DENIED_DEPENDENCY_SOURCE',
          severity: sourceKind === 'local-path' ? 'medium' : 'high',
          message: `Dependency source "${sourceKind}" is denied by policy.`,
          packageName: pkg.name,
        })
      }
      if (!this.config.allowedSourceKinds.has(sourceKind)) {
        findings.push({
          code: 'UNAPPROVED_DEPENDENCY_SOURCE',
          severity: 'high',
          message: `Dependency source "${sourceKind}" is not in the allowlist.`,
          packageName: pkg.name,
        })
      }
    }

    if (request.requestedNetworkPolicy && request.requestedNetworkPolicy !== 'none') {
      findings.push({
        code: 'RUNTIME_NETWORK_REQUIRES_APPROVAL',
        severity: 'medium',
        message: 'Runtime network access is denied by default and requires explicit approval.',
      })
    }

    const highestSeverity = highestFindingSeverity(findings)
    const status = packages.length === 0 && findings.length === 0
      ? 'approved'
      : highestSeverity === 'high'
        ? 'denied'
        : 'needs-approval'

    return {
      status,
      riskTier: riskTierForSeverity(highestSeverity),
      findings: dedupeFindings(findings),
      policyVersion: this.config.policyVersion,
    }
  }

  evaluateRuntimeCommand(command = []) {
    if (!Array.isArray(command) || command.length === 0) {
      return { allowed: false, reason: 'empty-command' }
    }
    return { allowed: true }
  }
}

export function normalizePolicyConfig(config = {}) {
  return {
    policyVersion: config.policyVersion || 'python-dependency-policy-v1',
    trustedIndexes: config.trustedIndexes || [{
      name: 'platform-pypi-proxy',
      url: 'https://pypi.org/simple',
      explicit: true,
    }],
    deniedRuntimeCommands:
      config.deniedRuntimeCommands || DEFAULT_DENIED_RUNTIME_COMMANDS,
    allowedSourceKinds: new Set(
      config.allowedSourceKinds || DEFAULT_ALLOWED_SOURCE_KINDS
    ),
    deniedSourceKinds: new Set(
      config.deniedSourceKinds || DEFAULT_DENIED_SOURCE_KINDS
    ),
    maxPackageCount: Number.isInteger(config.maxPackageCount)
      ? config.maxPackageCount
      : 50,
    maxWheelBytes: Number.isInteger(config.maxWheelBytes)
      ? config.maxWheelBytes
      : 100 * 1024 * 1024,
    nativeBuildPolicy: config.nativeBuildPolicy || 'deny-by-default',
    licensePolicy: config.licensePolicy || 'record-only',
    vulnerabilitySeverityThreshold:
      config.vulnerabilitySeverityThreshold || 'high',
    runtimeNetworkPolicy: config.runtimeNetworkPolicy || 'none',
  }
}

function highestFindingSeverity(findings) {
  if (findings.some(finding => finding.severity === 'high')) return 'high'
  if (findings.some(finding => finding.severity === 'medium')) return 'medium'
  if (findings.some(finding => finding.severity === 'low')) return 'low'
  return 'none'
}

function riskTierForSeverity(severity) {
  if (severity === 'high') return 'high'
  if (severity === 'medium') return 'medium'
  if (severity === 'low') return 'low'
  return 'low'
}

function dedupeFindings(findings) {
  const seen = new Set()
  const result = []
  for (const finding of findings) {
    const key = [
      finding.code,
      finding.packageName || '',
      finding.message || '',
    ].join(':')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(finding)
  }
  return result
}

export default DependencyPolicyEngine
