import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import { WorkspaceCommandService } from '../sandbox/WorkspaceCommandService.js'
import { SandboxPolicyError } from '../sandbox/SandboxErrors.js'

const runCommandSchema = z.object({
  command: z
    .array(z.string().min(1))
    .min(1)
    .describe('Argv-first command to run inside /workspace, for example ["python3", "--version"].'),
  workdir: z
    .string()
    .optional()
    .default('.')
    .describe('Workspace-relative working directory. Absolute paths and .. are blocked.'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .default(120000)
    .describe('Command timeout in milliseconds.'),
  max_output_bytes: z
    .number()
    .int()
    .min(1024)
    .max(2 * 1024 * 1024)
    .optional()
    .default(1024 * 1024)
    .describe('Maximum stdout/stderr bytes to collect.'),
  env: z
    .record(z.string())
    .optional()
    .default({})
    .describe('Optional safe environment variables. PATH, loader hooks, and secrets are blocked.'),
})

export class RunCommandTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'run_command',
      description: `Run a bounded argv-first command inside the persistent sandbox workspace.
Use this for project-local inspection and helper scripts. It never runs on the host and never writes canonical Overleaf documents directly.
Blocked commands return deterministic security errors. Ordinary non-zero exits are returned as structured command results.`,
      parameters: runCommandSchema,
    })
    this.commandService = options.commandService || new WorkspaceCommandService()
  }

  async execute(args, context) {
    try {
      const result = await this.commandService.run(args, context)
      const output = formatCommandOutput(result)
      return ToolResult.success(output, {
        commandId: result.commandId,
        summary: result.summary,
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        outputLimited: result.outputLimited,
        events: result.events,
      })
    } catch (error) {
      if (error instanceof SandboxPolicyError || error.code?.startsWith('SANDBOX_')) {
        const message = formatPolicyDenial(error)
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

function formatPolicyDenial(error) {
  const code = error.code || 'SANDBOX_COMMAND_POLICY_DENIED'
  const lines = [
    `Command blocked by sandbox policy: ${error.message}`,
    `Error code: ${code}`,
  ]
  if (error.info?.reason) {
    lines.push(`Reason: ${error.info.reason}`)
  }
  if (code === 'PACKAGE_MANAGER_DENIED') {
    lines.push(
      'Python package installation must go through the dependency broker and approved environment snapshots.'
    )
  }
  return lines.join('\n')
}

function formatCommandOutput(result) {
  const lines = [
    `Command: ${result.summary}`,
    `Exit code: ${result.exitCode === null ? 'unknown' : result.exitCode}`,
  ]
  if (result.timedOut) lines.push('Timed out: true')
  if (result.outputLimited) lines.push('Output limited: true')
  if (result.stdout) lines.push('', 'stdout:', result.stdout)
  if (result.stderr) lines.push('', 'stderr:', result.stderr)
  if (!result.stdout && !result.stderr) lines.push('', '(no output)')
  return lines.join('\n')
}

export default RunCommandTool
