import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    log: vi.fn(),
  },
}))

vi.mock('@overleaf/o-error', () => {
  class OError extends Error {
    constructor(message, info) {
      super(message)
      this.name = this.constructor.name
      this.info = info
    }
  }
  return { default: OError }
})

const { SyncWorkspaceChangesTool } = await import(
  '../../../../app/js/tool/sync_workspace_changes.js'
)

describe('SyncWorkspaceChangesTool', () => {
  let workspaceManager
  let context

  beforeEach(() => {
    workspaceManager = {
      syncPendingChanges: vi.fn(),
    }
    context = {
      sessionId: '0123456789abcdef01234567',
      projectId: 'abcdef0123456789abcdef01',
      userId: 'fedcba9876543210fedcba98',
      persistentWorkspace: {
        workspace: { _id: 'workspace-1' },
      },
      workspaceManager,
    }
  })

  it('syncs workspace diff into pending change summaries', async () => {
    workspaceManager.syncPendingChanges.mockResolvedValue({
      changeCount: 2,
      pendingChanges: [
        {
          id: 'change-1',
          projectId: context.projectId,
          docId: 'doc-1',
          type: 'edit',
          path: '/main.tex',
          status: 'pending',
          oldText: 'old',
          newText: 'new',
        },
        { id: 'change-2', type: 'create', path: '/sections/new.tex', status: 'pending' },
      ],
    })
    const tool = new SyncWorkspaceChangesTool()

    const result = await tool.execute({ fail_on_drift: true }, context)

    expect(result.success).toBe(true)
    expect(result.output).toContain('2 change(s) queued')
    expect(result.output).toContain('Canonical Overleaf documents were not modified')
    expect(result.data.pendingChangeIds).toEqual(['change-1', 'change-2'])
    expect(result.data.pendingChanges[0]).to.include({
      id: 'change-1',
      docId: 'doc-1',
      oldText: 'old',
      newText: 'new',
    })
    expect(workspaceManager.syncPendingChanges).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      projectId: context.projectId,
      userId: context.userId,
      workspace: { _id: 'workspace-1' },
      failOnDrift: true,
    })
  })

  it('reports clean workspace without pending changes', async () => {
    workspaceManager.syncPendingChanges.mockResolvedValue({
      changeCount: 0,
      pendingChanges: [],
    })
    const tool = new SyncWorkspaceChangesTool()

    const result = await tool.execute({}, context)

    expect(result.success).toBe(true)
    expect(result.output).toContain('Workspace is clean')
    expect(result.data.changeCount).toBe(0)
  })


  it('returns existing draft-backed pending changes without creating duplicate workspace diffs', async () => {
    context.sessionState = {
      pendingDraftChanges: [
        {
          id: 'draft-change-1',
          type: 'edit',
          source: 'persistent-workspace',
          path: '/main.tex',
          status: 'pending',
          oldText: 'old',
          newText: 'new',
        },
      ],
    }
    const tool = new SyncWorkspaceChangesTool()

    const result = await tool.execute({}, context)

    expect(result.success).toBe(true)
    expect(result.output).toContain('Workspace changes collected: 1 change(s) queued')
    expect(result.data.draftBacked).toBe(true)
    expect(result.data.pendingChangeIds).toEqual(['draft-change-1'])
    expect(workspaceManager.syncPendingChanges).not.toHaveBeenCalled()
  })

  it('requires a workspace manager and persistent workspace', async () => {
    const tool = new SyncWorkspaceChangesTool()

    const noManager = await tool.execute({}, {
      sessionId: context.sessionId,
      projectId: context.projectId,
      userId: context.userId,
      persistentWorkspace: context.persistentWorkspace,
    })
    const noWorkspace = await tool.execute({}, {
      sessionId: context.sessionId,
      projectId: context.projectId,
      userId: context.userId,
      workspaceManager,
    })

    expect(noManager.success).toBe(false)
    expect(noManager.output).toContain('Workspace manager is not available')
    expect(noWorkspace.success).toBe(false)
    expect(noWorkspace.output).toContain('requires a persistent workspace')
  })

  it('surfaces drift as a tool error', async () => {
    const driftError = new Error('drift')
    driftError.code = 'WORKSPACE_DRIFT_DETECTED'
    driftError.drift = {
      changes: [{ path: '/main.tex', type: 'version-mismatch' }],
    }
    workspaceManager.syncPendingChanges.mockRejectedValue(driftError)
    const tool = new SyncWorkspaceChangesTool()

    const result = await tool.execute({}, context)

    expect(result.success).toBe(false)
    expect(result.output).toContain('Workspace drift detected')
    expect(result.output).toContain('/main.tex')
  })
})
