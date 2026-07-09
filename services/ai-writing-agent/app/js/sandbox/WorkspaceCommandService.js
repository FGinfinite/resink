import { SandboxOutputLimitError, SandboxPolicyError, SandboxTimeoutError } from './SandboxErrors.js'
import { SandboxEscapeGuard } from './SandboxEscapeGuard.js'

export class WorkspaceCommandService {
  constructor(options = {}) {
    this.guard = options.guard || new SandboxEscapeGuard()
    this.now = options.now || (() => new Date())
  }

  async run(input = {}, context = {}) {
    const sandboxSession = context.persistentWorkspace?.sandboxSession
    if (!sandboxSession) {
      throw new SandboxPolicyError('run_command requires a persistent sandbox workspace', {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'missing-persistent-sandbox',
      })
    }
    let requested
    try {
      requested = this.guard.validateCommandRequest(input)
    } catch (error) {
      if (
        error instanceof SandboxPolicyError ||
        error.code?.startsWith('SANDBOX_') ||
        error.code === 'PACKAGE_MANAGER_DENIED'
      ) {
        error.info = {
          ...(error.info || {}),
          events: [
            ...((error.info || {}).events || []),
            this.buildPolicyDeniedEvent(input, context, error),
          ],
        }
      }
      throw error
    }
    await this.validateScriptExecution(requested, sandboxSession, context)
    const baseEvent = this.buildBaseEvent(requested, context)

    const events = [{
      type: 'command.started',
      ...baseEvent,
      startedAt: this.now().toISOString(),
    }]

    let stdout = ''
    let stderr = ''
    let exitCode = null
    let signal = null
    let timedOut = false
    let outputLimited = false

    try {
      for await (const event of sandboxSession.run({
        command: requested.command,
        workdir: requested.workdir,
        env: requested.env,
        timeoutMs: requested.timeoutMs,
        maxOutputBytes: requested.maxOutputBytes,
      })) {
        if (event.type === 'stdout') {
          const data = this.guard.redact(event.data || '')
          stdout += data
          events.push({ type: 'command.output', stream: 'stdout', data, ...baseEvent })
        } else if (event.type === 'stderr') {
          const data = this.guard.redact(event.data || '')
          stderr += data
          events.push({ type: 'command.output', stream: 'stderr', data, ...baseEvent })
        } else if (event.type === 'exit') {
          exitCode = event.exitCode ?? null
          signal = event.signal ?? null
        }
      }
    } catch (error) {
      if (error instanceof SandboxTimeoutError || error.code === 'SANDBOX_TIMEOUT') {
        timedOut = true
      } else if (error instanceof SandboxOutputLimitError || error.code === 'SANDBOX_OUTPUT_LIMIT') {
        outputLimited = true
      } else {
        throw error
      }
    }

    const completed = {
      type: timedOut || outputLimited ? 'command.failed' : 'command.completed',
      ...baseEvent,
      exitCode,
      signal,
      timedOut,
      outputLimited,
      completedAt: this.now().toISOString(),
    }
    events.push(completed)

    return {
      commandId: requested.commandId,
      summary: requested.summary,
      command: requested.command,
      workdir: requested.workdir,
      stdout,
      stderr,
      exitCode,
      signal,
      timedOut,
      outputLimited,
      events,
    }
  }

  async validateScriptExecution(requested, sandboxSession, context) {
    const scriptPath = this.guard.scriptPathFromCommand(requested.command)
    if (!scriptPath) return
    let content
    try {
      content = await sandboxSession.readFile(scriptPath)
    } catch (error) {
      const policyError = new SandboxPolicyError(
        'Workspace script must be readable before execution',
        {
          code: 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: 'script-not-readable',
          path: scriptPath,
        }
      )
      policyError.info = {
        ...(policyError.info || {}),
        events: [this.buildPolicyDeniedEvent({
          command: requested.command,
          workdir: requested.workdir,
        }, context, policyError)],
      }
      throw policyError
    }
    try {
      this.guard.validateScriptContent(content.toString('utf8'), {
        executable: requested.command[0],
        path: scriptPath,
      })
    } catch (error) {
      if (error instanceof SandboxPolicyError || error.code === 'PACKAGE_MANAGER_DENIED') {
        error.info = {
          ...(error.info || {}),
          events: [this.buildPolicyDeniedEvent({
            command: requested.command,
            workdir: requested.workdir,
          }, context, error)],
        }
      }
      throw error
    }
  }

  buildBaseEvent(requested, context) {
    return {
      commandId: requested.commandId,
      sessionId: context.sessionId,
      turnId: context.turnId || null,
      toolCallId: context.toolCallId || null,
      workspaceId: context.persistentWorkspace?.workspace?._id || null,
      sandboxSessionId: context.persistentWorkspace?.sandboxSession?.id || null,
      summary: requested.summary,
      workdir: requested.workdir,
      provenance: {
        agentName: context.agentName || null,
        profile: context.profile || null,
        rootSessionId: context.rootSessionId || context.sessionId || null,
      },
    }
  }

  buildPolicyDeniedEvent(input, context, error) {
    const command = Array.isArray(input.command) ? input.command : []
    const workdir = typeof input.workdir === 'string' ? input.workdir : '.'
    return {
      type: error.code === 'PACKAGE_MANAGER_DENIED'
        ? 'python_environment.runtime_denied'
        : 'security.command_blocked',
      sessionId: context.sessionId,
      turnId: context.turnId || null,
      toolCallId: context.toolCallId || null,
      workspaceId: context.persistentWorkspace?.workspace?._id || null,
      sandboxSessionId: context.persistentWorkspace?.sandboxSession?.id || null,
      reason: error.info?.reason || error.code || 'sandbox-policy',
      code: error.code || 'SANDBOX_COMMAND_POLICY_DENIED',
      command,
      summary: command.length > 0
        ? this.guard.safeCommandSummary(command, workdir)
        : null,
      message: error.message,
      provenance: {
        agentName: context.agentName || null,
        profile: context.profile || null,
        rootSessionId: context.rootSessionId || context.sessionId || null,
      },
    }
  }
}

export default WorkspaceCommandService
