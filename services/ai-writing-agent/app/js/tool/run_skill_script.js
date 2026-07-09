import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { SkillRuntimeService } from '../skill/SkillRuntimeService.js'
import { SandboxPolicyError } from '../sandbox/SandboxErrors.js'

const runSkillScriptSchema = z.object({
  skill: z.string().describe('Directory-based skill package name.'),
  script: z.string().describe('Declared script file name from activate_skill metadata.'),
  args: z.array(z.string()).optional().default([]).describe('Argv arguments passed to the projected script.'),
  workdir: z.string().optional().default('.').describe('Workspace-relative working directory.'),
  timeout_ms: z.number().int().min(1000).max(300000).optional().default(120000),
  max_output_bytes: z.number().int().min(1024).max(2 * 1024 * 1024).optional().default(1024 * 1024),
  env: z.record(z.string()).optional().default({}),
})

export class RunSkillScriptTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'run_skill_script',
      description: `Run one declared skill script inside the persistent sandbox workspace.
The script is copied into .skills/<skill>/scripts/ before execution and runs through the same sandbox-only command policy as run_command.
Undeclared scripts, host paths, path traversal, missing sandbox, and unsafe env/commands are rejected.`,
      parameters: runSkillScriptSchema,
    })
    this.skillRuntime = options.skillRuntime || new SkillRuntimeService(options)
  }

  async execute(args, context) {
    try {
      const result = await this.skillRuntime.runScript(args, context)
      return ToolResult.success(formatSkillScriptOutput(result), {
        skillName: result.skillName,
        script: result.script,
        path: result.path,
        runtime: result.runtime,
        commandId: result.command.commandId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        outputLimited: result.outputLimited,
        provenance: result.provenance,
        events: result.events,
      })
    } catch (error) {
      if (error instanceof SandboxPolicyError || error.code?.startsWith('SANDBOX_')) {
        const message = formatPolicyError(error)
        return ToolResult.error(message, {
          code: error.code || 'SANDBOX_COMMAND_POLICY_DENIED',
          reason: error.info?.reason,
          events: error.info?.events || [{
            type: 'security.command_blocked',
            sessionId: context.sessionId,
            toolCallId: context.toolCallId || null,
            reason: error.info?.reason || error.code || 'sandbox-policy',
            message,
          }],
        })
      }
      throw error
    }
  }
}

function formatPolicyError(error) {
  const lines = [`Skill script blocked by sandbox policy: ${error.message}`]
  if (error.code === 'PYTHON_ENV_NOT_APPROVED') {
    const requestId = error.info?.dependencyRequestId
    const fingerprint = error.info?.fingerprint
    if (requestId) {
      lines.push(`Dependency request id: ${requestId}`)
    }
    if (fingerprint) {
      lines.push(`Dependency fingerprint: ${fingerprint}`)
    }
    lines.push('Approve this request in Dependency Approvals, then retry the same skill script.')
  }
  return lines.join('\n')
}

function formatSkillScriptOutput(result) {
  const lines = [
    `Skill script: ${result.skillName}/${result.script}`,
    `Runtime: ${result.runtime}`,
    `Sandbox path: ${result.path}`,
    `Exit code: ${result.exitCode === null ? 'unknown' : result.exitCode}`,
  ]
  if (result.timedOut) lines.push('Timed out: true')
  if (result.outputLimited) lines.push('Output limited: true')
  if (result.stdout) lines.push('', 'stdout:', result.stdout)
  if (result.stderr) lines.push('', 'stderr:', result.stderr)
  if (!result.stdout && !result.stderr) lines.push('', '(no output)')
  return lines.join('\n')
}

export default RunSkillScriptTool
