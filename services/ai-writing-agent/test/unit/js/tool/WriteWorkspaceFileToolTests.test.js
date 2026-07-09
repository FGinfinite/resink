import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi, afterEach } from 'vitest'

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

const { WriteWorkspaceFileTool } = await import(
  '../../../../app/js/tool/write_workspace_file.js'
)

const tempDirs = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function buildContext() {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'write-workspace-file-test-'))
  tempDirs.push(workspacePath)
  return {
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    profile: 'default',
    persistentWorkspace: {
      workspace: { _id: 'workspace-1' },
      sandboxSession: {
        id: 'sandbox-1',
        workspacePath,
        writeFile: vi.fn(),
      },
    },
  }
}

describe('WriteWorkspaceFileTool', () => {
  it('writes helper files under .agent and emits workspace.file_written', async () => {
    const context = await buildContext()
    const tool = new WriteWorkspaceFileTool()

    const result = await tool.execute({
      path: '.agent/tmp/check.js',
      content: 'console.log("ok")\n',
    }, context)

    expect(result.success).toBe(true)
    expect(context.persistentWorkspace.sandboxSession.writeFile).toHaveBeenCalledWith(
      '.agent/tmp/check.js',
      'console.log("ok")\n'
    )
    expect(result.data).toMatchObject({
      path: '.agent/tmp/check.js',
      events: [{
        type: 'workspace.file_written',
        path: '.agent/tmp/check.js',
        size: 18,
        sandboxSessionId: 'sandbox-1',
      }],
    })
  })

  it('rejects project files and path escapes without writing', async () => {
    const context = await buildContext()
    const tool = new WriteWorkspaceFileTool()

    for (const filePath of [
      'main.tex',
      '../escape.js',
      '/workspace/.agent/tmp/x.js',
      '.agent/../main.tex',
    ]) {
      const result = await tool.execute({ path: filePath, content: 'x' }, context)
      expect(result.success).toBe(false)
      expect(result.data.events[0]).toMatchObject({
        type: 'security.command_blocked',
      })
    }
    expect(context.persistentWorkspace.sandboxSession.writeFile).not.toHaveBeenCalled()
  })

  it('fails closed without a persistent sandbox', async () => {
    const tool = new WriteWorkspaceFileTool()

    const result = await tool.execute({
      path: '.agent/tmp/check.js',
      content: 'x',
    }, { sessionId: 'session-1' })

    expect(result.success).toBe(false)
    expect(result.data.reason).toBe('missing-persistent-sandbox')
  })
})
