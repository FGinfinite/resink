import { z } from 'zod'
import path from 'node:path'
import { Tool, ToolResult } from './Tool.js'
import { SandboxPolicyError } from '../sandbox/SandboxErrors.js'

const MAX_WORKSPACE_FILE_BYTES = 256 * 1024

const writeWorkspaceFileSchema = z.object({
  path: z
    .string()
    .describe('Workspace-relative path under .agent/tmp/ or .agent/scripts/.'),
  content: z
    .string()
    .max(MAX_WORKSPACE_FILE_BYTES, 'content exceeds 256KB limit')
    .describe('UTF-8 text content to write into the sandbox workspace.'),
})

export class WriteWorkspaceFileTool extends Tool {
  constructor() {
    super({
      name: 'write_workspace_file',
      description: `Write a text helper file inside the persistent sandbox workspace.
Only .agent/tmp/ and .agent/scripts/ are allowed. Use this to create temporary scripts or data files, then run them with run_command.
This never writes canonical Overleaf documents and never creates a pending change.`,
      parameters: writeWorkspaceFileSchema,
    })
  }

  async execute(args, context) {
    const sandboxSession = context.persistentWorkspace?.sandboxSession
    if (!sandboxSession) {
      return policyError('write_workspace_file requires a persistent sandbox workspace', {
        code: 'SANDBOX_COMMAND_POLICY_DENIED',
        reason: 'missing-persistent-sandbox',
      }, context)
    }

    let filePath
    try {
      filePath = normalizeAgentWorkspacePath(args.path)
    } catch (error) {
      return policyError(error.message, error.info || {
        code: error.code,
        reason: 'invalid-agent-workspace-path',
      }, context)
    }

    await sandboxSession.writeFile(filePath, args.content)
    const size = Buffer.byteLength(args.content, 'utf8')
    const event = {
      type: 'workspace.file_written',
      sessionId: context.sessionId,
      toolCallId: context.toolCallId || null,
      workspaceId: context.persistentWorkspace?.workspace?._id || null,
      sandboxSessionId: sandboxSession.id || null,
      path: filePath,
      size,
      provenance: {
        agentName: context.agentName || null,
        profile: context.profile || null,
        rootSessionId: context.rootSessionId || context.sessionId || null,
      },
    }

    return ToolResult.success(
      `Wrote sandbox workspace file ${filePath} (${size} bytes).`,
      { path: filePath, size, events: [event] }
    )
  }
}

function normalizeAgentWorkspacePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new SandboxPolicyError('Workspace file path is required', {
      code: 'SANDBOX_PATH_POLICY_DENIED',
      reason: 'empty-path',
    })
  }
  if (rawPath.includes('\\') || rawPath.includes('\0') || path.posix.isAbsolute(rawPath)) {
    throw new SandboxPolicyError('Workspace file path must be a relative POSIX path', {
      code: 'SANDBOX_PATH_POLICY_DENIED',
      reason: 'invalid-agent-workspace-path',
      path: rawPath,
    })
  }
  const normalized = path.posix.normalize(rawPath)
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    !(
      normalized.startsWith('.agent/tmp/') ||
      normalized.startsWith('.agent/scripts/')
    )
  ) {
    throw new SandboxPolicyError(
      'write_workspace_file can only write under .agent/tmp/ or .agent/scripts/',
      {
        code: 'SANDBOX_PATH_POLICY_DENIED',
        reason: 'agent-workspace-path-not-allowed',
        path: rawPath,
      }
    )
  }
  return normalized
}

function policyError(message, info, context) {
  return ToolResult.error(`Workspace file write blocked by sandbox policy: ${message}`, {
    code: info.code || 'SANDBOX_PATH_POLICY_DENIED',
    reason: info.reason,
    events: [{
      type: 'security.command_blocked',
      sessionId: context.sessionId,
      toolCallId: context.toolCallId || null,
      reason: info.reason || info.code || 'sandbox-policy',
      message,
    }],
  })
}

export default WriteWorkspaceFileTool
