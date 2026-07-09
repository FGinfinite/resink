import path from 'node:path'
import { WorkspaceCommandService } from '../sandbox/WorkspaceCommandService.js'
import { SandboxPolicyError } from '../sandbox/SandboxErrors.js'
import { PythonRuntimeMountService } from '../python/PythonRuntimeMountService.js'
import { PythonDependencyRequestService } from '../python/PythonDependencyRequestService.js'

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

export class SkillRuntimeService {
  constructor(options = {}) {
    this.skillRegistry = options.skillRegistry
    this.commandService = options.commandService || new WorkspaceCommandService()
    this.pythonRuntimeMount = options.pythonRuntimeMount || new PythonRuntimeMountService()
    this.requestService = options.requestService || new PythonDependencyRequestService()
  }

  async runScript(input = {}, context = {}) {
    const sandboxSession = context.persistentWorkspace?.sandboxSession
    if (!sandboxSession) {
      throw new SandboxPolicyError('run_skill_script requires a persistent sandbox workspace', {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'missing-persistent-sandbox',
      })
    }

    const script = await this.resolveScript(input.skill, input.script)
    const projectedPath = this.projectedScriptPath(script)
    const runtime = script.runtime || this.inferRuntime(script.name)
    if (!runtime) {
      throw new SandboxPolicyError(`Skill script "${script.name}" has no supported runtime`, {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'unsupported-skill-script-runtime',
        script: script.name,
      })
    }
    const pythonRuntime = await this.preparePythonRuntime(script, runtime, context)

    await sandboxSession.writeFile(projectedPath, script.content)

    const startedEvent = {
      type: 'skill.script.started',
      skillName: script.skillName,
      script: script.name,
      path: projectedPath,
      runtime,
      sessionId: context.sessionId,
      toolCallId: context.toolCallId || null,
      provenance: script.provenance,
    }
    const commandResult = await this.commandService.run({
      command: [runtime, projectedPath, ...(input.args || [])],
      workdir: input.workdir || '.',
      timeout_ms: input.timeout_ms || DEFAULT_TIMEOUT_MS,
      max_output_bytes: input.max_output_bytes || DEFAULT_MAX_OUTPUT_BYTES,
      env: {
        ...(input.env || {}),
        ...(pythonRuntime?.env || {}),
      },
    }, context)
    const completedEvent = {
      type: 'skill.script.completed',
      skillName: script.skillName,
      script: script.name,
      path: projectedPath,
      runtime,
      sessionId: context.sessionId,
      toolCallId: context.toolCallId || null,
      commandId: commandResult.commandId,
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut,
      outputLimited: commandResult.outputLimited,
      provenance: script.provenance,
    }

    return {
      skillName: script.skillName,
      script: script.name,
      path: projectedPath,
      runtime,
      command: commandResult,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      exitCode: commandResult.exitCode,
      timedOut: commandResult.timedOut,
      outputLimited: commandResult.outputLimited,
      events: [
        startedEvent,
        ...(pythonRuntime?.events || []),
        ...commandResult.events,
        completedEvent,
      ],
      provenance: script.provenance,
    }
  }

  async preparePythonRuntime(script, runtime, context) {
    if (runtime !== 'python' && runtime !== 'python3') return null
    const python = script.python
    if (!python?.required) return null
    if (python.status === 'approved' && python.environmentId) {
      return this.attachPythonEnvironment(python.environmentId, script, context)
    }
    const approved = await this.findApprovedEnvironment(script, python, context)
    if (approved?.environmentId) {
      return this.attachPythonEnvironment(approved.environmentId, script, context)
    }
    const persistedRequest = await this.persistDependencyRequest(script, python, context)
    throw new SandboxPolicyError(
      'The script requires an approved Python environment before execution.',
      {
        code: 'PYTHON_ENV_NOT_APPROVED',
        reason: 'python-env-not-approved',
        skillName: script.skillName,
        script: script.name,
        dependencyRequestId:
          persistedRequest?._id?.toString?.() ||
          persistedRequest?.id ||
          python.dependencyRequest?.id ||
          python.dependencyRequest?._id ||
          python.dependencyRequest?.fingerprint ||
          null,
        fingerprint: python.dependencyRequest?.fingerprint || null,
        requestedEnvironmentKey: python.requestedEnvironmentKey || null,
        policyFindings: python.policyFindings || [],
      }
    )
  }

  async attachPythonEnvironment(environmentId, script, context) {
    const attachment = await this.pythonRuntimeMount.attach({
      environmentId,
      skillName: script.skillName,
      scriptPath: script.relativePath,
    }, context)
    return {
      ...attachment,
      env: {
        ...(attachment.env || {}),
        PYTHON_ENV_ROOT: attachment.targetRoot,
      },
    }
  }

  async findApprovedEnvironment(script, python, context) {
    const fingerprint = python.dependencyRequest?.fingerprint
    if (!fingerprint || !this.requestService?.findApprovedByFingerprint) return null
    return this.requestService.findApprovedByFingerprint(fingerprint, {
      projectId: context.projectId,
      skillName: script.skillName,
    })
  }

  async persistDependencyRequest(script, python, context) {
    if (!python?.dependencyRequest || !this.requestService?.upsertFromDependencyRequest) {
      return null
    }
    return this.requestService.upsertFromDependencyRequest({
      projectId: context.projectId || null,
      sessionId: context.sessionId || null,
      userId: context.userId || null,
      dependencyRequest: {
        ...python.dependencyRequest,
        scope: python.dependencyRequest.scope || 'skill',
        skillName: python.dependencyRequest.skillName || script.skillName,
        scriptPath: python.dependencyRequest.scriptPath || script.relativePath,
      },
      status: 'pending',
      riskTier: python.riskTier || null,
    })
  }

  async resolveScript(skillName, scriptName) {
    if (!this.skillRegistry?.readScript) {
      throw new SandboxPolicyError('Skill registry does not support script loading', {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'skill-script-registry-unavailable',
      })
    }

    const script = await this.skillRegistry.readScript(skillName, scriptName)
    if (!script) {
      throw new SandboxPolicyError(`Unknown skill script "${scriptName}" for skill "${skillName}"`, {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'undeclared-skill-script',
        skill: skillName,
        script: scriptName,
      })
    }
    return script
  }

  projectedScriptPath(script) {
    const safeSkill = this.normalizeName(script.skillName)
    const safeScript = this.normalizeName(script.name)
    return path.posix.join('.skills', safeSkill, 'scripts', safeScript)
  }

  normalizeName(value) {
    if (typeof value !== 'string' || value.includes('/') || value.includes('\\') || value.includes('\0') || value === '..') {
      throw new SandboxPolicyError('Invalid skill script path', {
        code: 'SANDBOX_PATH_POLICY_DENIED',
        reason: 'invalid-skill-script-path',
      })
    }
    return value
  }

  inferRuntime(fileName) {
    if (fileName.endsWith('.py')) return 'python3'
    if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) return 'node'
    if (fileName.endsWith('.rb')) return 'ruby'
    if (fileName.endsWith('.pl')) return 'perl'
    if (fileName.endsWith('.sh')) return 'sh'
    return null
  }
}

export default SkillRuntimeService
