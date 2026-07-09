import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { ProjectDependencyResolver } from '../python/ProjectDependencyResolver.js'
import { DependencyPolicyEngine } from '../python/DependencyPolicyEngine.js'
import { PythonDependencyRequestService } from '../python/PythonDependencyRequestService.js'

const MAX_SCAN_FILES = 200
const MAX_FILE_BYTES = 128 * 1024
const PYTHON_METADATA_RE = /(^|\/)(pyproject\.toml|uv\.lock|\.python-version)$|\.py$/i

const inspectPythonEnvironmentSchema = z.object({
  include_scripts: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to inspect Python scripts for PEP 723 metadata.'),
})

export class InspectPythonEnvironmentTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'inspect_python_environment',
      description: `Inspect project Python dependency metadata in the persistent sandbox workspace.
This is read-only: it lists pyproject.toml, uv.lock, .python-version, and PEP 723 script metadata, then reports whether a broker-approved environment is needed.
It never installs packages, runs uv, or approves dependencies.`,
      parameters: inspectPythonEnvironmentSchema,
    })
    this.projectDependencyResolver =
      options.projectDependencyResolver || new ProjectDependencyResolver()
    this.policyEngine = options.policyEngine || new DependencyPolicyEngine()
    this.requestService =
      options.requestService || new PythonDependencyRequestService()
  }

  async execute(args, context = {}) {
    const sandboxSession = context.persistentWorkspace?.sandboxSession
    if (!sandboxSession) {
      return ToolResult.error(
        'inspect_python_environment requires a persistent sandbox workspace.',
        {
          code: 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: 'missing-persistent-sandbox',
        }
      )
    }

    const files = await this.collectMetadataFiles(sandboxSession, args)
    const result = await this.projectDependencyResolver.resolveFromFiles(files)
    const policyDecision = result.dependencyRequest
      ? this.policyEngine.evaluateRequest(result.dependencyRequest)
      : { status: 'approved', riskTier: 'low', findings: [] }
    const persistedRequest = result.required && result.dependencyRequest
      ? await this.requestService.upsertFromDependencyRequest({
          projectId: context.projectId || null,
          sessionId: context.sessionId || null,
          userId: context.userId || null,
          dependencyRequest: result.dependencyRequest,
          status: policyDecision.status === 'denied' ? 'needs-approval' : 'pending',
          riskTier: policyDecision.riskTier,
        })
      : null
    const events = result.required
      ? [{
          type: 'python_dependency.requested',
          scope: 'project',
          status: result.status,
          projectId: context.projectId || null,
          sessionId: context.sessionId,
          dependencyRequestId:
            persistedRequest?._id?.toString?.() ||
            result.dependencyRequest.fingerprint,
          fingerprint: result.dependencyRequest.fingerprint,
          riskTier: policyDecision.riskTier,
          policyFindings: policyDecision.findings,
        }]
      : []

    return ToolResult.success(formatInspection(result, policyDecision), {
      required: result.required,
      status: result.status,
      dependencyRequest: result.dependencyRequest,
      persistedRequest: persistedRequest ? serializePersistedRequest(persistedRequest) : null,
      packages: result.packages,
      policyDecision,
      sourceFiles: result.sourceFiles,
      events,
    })
  }

  async collectMetadataFiles(sandboxSession, args = {}) {
    const listed = await sandboxSession.listFiles('.')
    const candidates = listed
      .map(file => file.path || file.name || '')
      .filter(path => path && PYTHON_METADATA_RE.test(path))
      .filter(path => args.include_scripts !== false || !path.endsWith('.py'))
      .slice(0, MAX_SCAN_FILES)
    const files = []
    for (const filePath of candidates) {
      const metadata = listed.find(file => (file.path || file.name) === filePath)
      if (metadata?.size && metadata.size > MAX_FILE_BYTES) continue
      const content = await sandboxSession.readFile(filePath)
      if (content.length > MAX_FILE_BYTES) continue
      files.push({
        path: filePath,
        content: content.toString('utf-8'),
      })
    }
    return files
  }
}

function serializePersistedRequest(request) {
  return {
    id: request._id?.toString?.() || request.id || request.fingerprint,
    status: request.status || null,
    environmentId: request.environmentId || null,
    fingerprint: request.fingerprint || null,
  }
}

function formatInspection(result, policyDecision) {
  if (!result.required) {
    return 'No Python dependency metadata found in the sandbox workspace.'
  }
  const lines = [
    `Project Python environment status: ${result.status}`,
    `Dependency request: ${result.dependencyRequest.fingerprint}`,
    `Risk tier: ${policyDecision.riskTier}`,
    `Source files: ${result.sourceFiles.map(file => file.path).join(', ') || '(none)'}`,
  ]
  if (result.packages.length > 0) {
    lines.push(
      `Packages: ${result.packages.map(pkg => pkg.raw || pkg.name).join(', ')}`
    )
  }
  const findings = [
    ...(result.policyFindings || []),
    ...(policyDecision.findings || []),
  ]
  if (findings.length > 0) {
    lines.push('Policy findings:')
    for (const finding of findings) {
      lines.push(`- ${finding.severity || 'unknown'} ${finding.code}: ${finding.message}`)
    }
  }
  return lines.join('\n')
}

export default InspectPythonEnvironmentTool
