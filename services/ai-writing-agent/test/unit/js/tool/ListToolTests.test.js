import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@overleaf/settings', () => ({
  default: {
    list: {
      maxPatternLength: 200,
      lineCountMaxFiles: 50,
    },
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

const { ListFilesTool } = await import(
  '../../../../app/js/tool/list.js'
)

describe('ListFilesTool', () => {
  let tool
  let sandboxSession
  let context

  beforeEach(() => {
    tool = new ListFilesTool()
    sandboxSession = {
      listFiles: vi.fn().mockResolvedValue([
        { path: 'main.tex', size: 12 },
        { path: 'chapters/intro.tex', size: 20 },
        { path: 'figures/chart.png', size: 1000, type: 'file' },
      ]),
    }
    context = {
      projectId: 'proj-1',
      adapters: {},
      persistentWorkspace: { sandboxSession },
    }
  })

  it('lists workspace files from sandbox session with metadata', async () => {
    const result = await tool.execute({}, context)

    expect(result.success).toBe(true)
    expect(sandboxSession.listFiles).toHaveBeenCalledWith('.')
    expect(result.output).toContain('Workspace files (3 total)')
    expect(result.data.workspace).toBe(true)
    expect(result.data.files).toEqual([
      { path: 'main.tex', name: 'main.tex', type: 'doc', size: 12, mtime: undefined, modifiedAt: undefined },
      { path: 'chapters/intro.tex', name: 'intro.tex', type: 'doc', size: 20, mtime: undefined, modifiedAt: undefined },
      { path: 'figures/chart.png', name: 'chart.png', type: 'file', size: 1000, mtime: undefined, modifiedAt: undefined },
    ])
  })

  it('filters workspace files by pattern and type', async () => {
    const result = await tool.execute({ pattern: '*.tex', type: 'docs' }, context)

    expect(result.success).toBe(true)
    expect(result.data.files.map(file => file.path)).toEqual([
      'main.tex',
      'chapters/intro.tex',
    ])
  })
})
