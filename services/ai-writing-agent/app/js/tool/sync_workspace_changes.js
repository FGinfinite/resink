import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'

const syncWorkspaceChangesSchema = z.object({
  fail_on_drift: z
    .boolean()
    .optional()
    .default(true)
    .describe('Abort if canonical Overleaf documents changed since the workspace was exported.'),
})

export class SyncWorkspaceChangesTool extends Tool {
  constructor(options = {}) {
    super({
      name: 'sync_workspace_changes',
      description: `Convert persistent workspace edits into Overleaf pending changes.
This never applies changes directly. It diffs the sandbox workspace against the exported snapshot,
stores reviewable pending changes on the AI session, and reports what the user can accept or reject.`,
      parameters: syncWorkspaceChangesSchema,
    })
    this.workspaceManager = options.workspaceManager
  }

  async execute(args, context) {
    const manager = this.workspaceManager || context.workspaceManager
    const workspace = context.persistentWorkspace?.workspace

    if (!manager?.syncPendingChanges) {
      return ToolResult.error('Workspace manager is not available. Cannot sync pending changes.')
    }
    if (!workspace) {
      return ToolResult.error('sync_workspace_changes requires a persistent workspace.')
    }

    try {
      const existingDraftChanges = getPendingDraftChanges(context.sessionState)
      const result = existingDraftChanges.length > 0
        ? { changeCount: 0, pendingChanges: [] }
        : await manager.syncPendingChanges({
          sessionId: context.sessionId,
          projectId: context.projectId,
          userId: context.userId,
          workspace,
          failOnDrift: args.fail_on_drift !== false,
        })
      const pendingChanges = mergePendingChanges(
        existingDraftChanges,
        result.pendingChanges
      )
      return ToolResult.success(formatSyncOutput({
        changeCount: pendingChanges.length,
        pendingChanges,
        draftBacked: existingDraftChanges.length > 0,
      }), {
        workspace: true,
        workspaceId: workspace._id,
        changeCount: pendingChanges.length,
        pendingChangeIds: pendingChanges.map(change => change.id),
        pendingChanges,
        draftBacked: existingDraftChanges.length > 0,
      })
    } catch (error) {
      if (error.code === 'WORKSPACE_DRIFT_DETECTED') {
        return ToolResult.error(
          `Workspace drift detected. Re-sync or recreate the workspace before proposing changes.\n${formatDrift(error.drift)}`
        )
      }
      return ToolResult.error(`Failed to sync workspace changes: ${error.message}`)
    }
  }
}

function getPendingDraftChanges(sessionState) {
  const changes = [
    ...(Array.isArray(sessionState?.pendingDraftChanges) ? sessionState.pendingDraftChanges : []),
    ...(Array.isArray(sessionState?.changeHistory) ? sessionState.changeHistory : []),
  ]
  if (changes.length === 0) return []
  return changes.filter(change => (
    change &&
    change.status === 'pending' &&
    (change.source === 'persistent-workspace' || change.source === 'agent-loop-v2')
  ))
}

function mergePendingChanges(first, second) {
  const byId = new Map()
  for (const change of [...first, ...second]) {
    if (!change?.id) continue
    byId.set(change.id, change)
  }
  return Array.from(byId.values())
}

function formatSyncOutput(result) {
  if (result.changeCount === 0) {
    return 'Workspace is clean. No pending changes were created.'
  }

  const action = result.draftBacked ? 'collected' : 'synced'
  const lines = [
    `Workspace changes ${action}: ${result.changeCount} change(s) queued for user review.`,
    '',
    'Pending changes:',
  ]
  for (const change of result.pendingChanges) {
    const marker = change.artifact ? 'artifact' : change.type
    lines.push(`- ${change.id}: ${marker} ${change.path}`)
  }
  lines.push('', 'Canonical Overleaf documents were not modified. The user must accept or reject these pending changes.')
  return lines.join('\n')
}

function formatDrift(drift) {
  if (!drift?.changes?.length) return 'No drift details available.'
  return drift.changes
    .slice(0, 20)
    .map(change => `- ${change.path}: ${change.type}`)
    .join('\n')
}

export function createSyncWorkspaceChangesTool(options) {
  return new SyncWorkspaceChangesTool(options)
}

export default SyncWorkspaceChangesTool
