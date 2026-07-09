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

vi.mock('@overleaf/settings', () => ({
  default: {},
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

vi.mock('../../../../app/js/mongodb.js', () => ({
  db: {
    aiSandboxArtifacts: {
      insertMany: vi.fn(),
    },
  },
}))

const { CompileLatexTool } = await import(
  '../../../../app/js/tool/compile_latex.js'
)

describe('CompileLatexTool', () => {
  let artifactsCollection
  let sandboxSession
  let context

  beforeEach(() => {
    artifactsCollection = {
      insertMany: vi.fn(),
    }
    sandboxSession = {
      id: 'workspace-1',
      collectArtifacts: vi.fn(),
    }
    context = {
      sessionId: 'session-1',
      persistentWorkspace: { sandboxSession },
    }
  })

  it('requires a persistent workspace', async () => {
    const tool = new CompileLatexTool({ artifactsCollection })

    const result = await tool.execute({ entry_file: 'main.tex' }, { sessionId: 'session-1' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('requires a persistent workspace')
  })

  it('runs latexmk and stores bounded artifacts', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z')
    const commandService = {
      run: vi.fn().mockResolvedValue({
        commandId: 'cmd-1',
        summary: '/workspace$ latexmk -pdf main.tex',
        stdout: 'latexmk output sk-12345678901234567890',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputLimited: false,
        events: [{ type: 'command.completed', commandId: 'cmd-1', exitCode: 0 }],
      }),
    }
    const tool = new CompileLatexTool({
      artifactsCollection,
      commandService,
      now: () => now,
      artifactTtlMs: 1000,
    })
    sandboxSession.collectArtifacts.mockResolvedValue([
      {
        path: 'main.pdf',
        size: 8,
        content: Buffer.from('%PDF-1.4'),
      },
      {
        path: 'main.log',
        size: 21,
        content: Buffer.from('This is the compile log with sk-12345678901234567890.'),
      },
    ])

    const result = await tool.execute(
      { entry_file: 'main.tex', engine: 'pdf', timeout_ms: 30000 },
      context
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('LaTeX compile succeeded')
    expect(result.output).toContain('/api/ai/sessions/session-1/artifacts/')
    expect(result.output).not.toContain('sk-12345678901234567890')
    expect(commandService.run).toHaveBeenCalledWith({
      command: [
        'latexmk',
        '-pdf',
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        'main.tex',
      ],
      timeout_ms: 30000,
      max_output_bytes: 2 * 1024 * 1024,
    }, context)
    expect(sandboxSession.collectArtifacts).toHaveBeenCalledWith([
      'main.pdf',
      'main.log',
      'main.fls',
      'main.fdb_latexmk',
      'main.aux',
    ])
    expect(artifactsCollection.insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        sessionId: 'session-1',
        sandboxSessionId: 'workspace-1',
        path: 'main.pdf',
        content: Buffer.from('%PDF-1.4'),
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        path: 'main.log',
        preview: 'This is the compile log with [REDACTED].',
      }),
    ])
    expect(result.data.compiled).toBe(true)
    expect(result.data.commandId).toBe('cmd-1')
    expect(result.data.events).toEqual([{ type: 'command.completed', commandId: 'cmd-1', exitCode: 0 }])
    expect(result.data.artifacts).toHaveLength(2)
    expect(result.data.artifacts[0].artifactId).toBeDefined()
  })

  it('returns failed compile status with log artifacts', async () => {
    const commandService = {
      run: vi.fn().mockResolvedValue({
        commandId: 'cmd-2',
        summary: '/workspace$ latexmk -pdf main.tex',
        stdout: '',
        stderr: 'latex error',
        exitCode: 12,
        signal: null,
        timedOut: false,
        outputLimited: false,
        events: [{ type: 'command.completed', commandId: 'cmd-2', exitCode: 12 }],
      }),
    }
    const tool = new CompileLatexTool({ artifactsCollection, commandService })
    sandboxSession.collectArtifacts.mockResolvedValue([
      {
        path: 'main.log',
        size: 11,
        content: Buffer.from('! Undefined control sequence.'),
      },
    ])

    const result = await tool.execute({ entry_file: 'main.tex' }, context)

    expect(result.success).toBe(true)
    expect(result.data.compiled).toBe(false)
    expect(result.data.exitCode).toBe(12)
    expect(result.output).toContain('LaTeX compile failed')
    expect(result.output).toContain('Undefined control sequence')
  })

  it('rejects non-tex entry files and path escapes', async () => {
    const tool = new CompileLatexTool({ artifactsCollection })

    const nonTex = await tool.execute({ entry_file: 'refs.bib' }, context)
    const escape = await tool.execute({ entry_file: '../main.tex' }, context)

    expect(nonTex.success).toBe(false)
    expect(nonTex.output).toContain('entry_file must be a .tex file')
    expect(escape.success).toBe(false)
    expect(escape.output).toContain('segments are not allowed')
  })
})
