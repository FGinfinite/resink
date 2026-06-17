import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @overleaf/settings
vi.mock('@overleaf/settings', () => ({
  default: {
    document: {
      maxLines: 1000,
      maxChars: 50000,
      maxContentLength: 100000,
    },
    search: {
      maxResults: 50,
      defaultContextLines: 2,
    },
  },
}))

// Mock @overleaf/logger
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

// Mock @overleaf/o-error
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

const { LabelRefAuditTool } = await import(
  '../../../../app/js/tool/label_ref_audit.js'
)

describe('LabelRefAuditTool', () => {
  let tool
  let mockDocumentAdapter
  let mockProjectAdapter
  let mockContext

  beforeEach(() => {
    tool = new LabelRefAuditTool()

    mockDocumentAdapter = {
      getDocumentContent: vi.fn(),
    }

    mockProjectAdapter = {
      listFiles: vi.fn(),
      resolvePathToDocId: vi.fn(),
    }

    mockContext = {
      sessionId: 'session-1',
      projectId: 'proj-1',
      adapters: {
        document: mockDocumentAdapter,
        project: mockProjectAdapter,
      },
    }
  })

  it('has correct name "label_ref_audit"', () => {
    expect(tool.name).toBe('label_ref_audit')
  })

  describe('execute', () => {
    it('detects undefined references', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        '\\label{sec:intro}',
        'As shown in Figure~\\ref{fig:missing_figure}.',
        'See Section~\\ref{sec:intro}.',
        '\\end{document}',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, check_types: ['refs'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.refIssueCount).toBeGreaterThan(0)
      expect(result.output).toContain('UNDEFINED')
      expect(result.output).toContain('fig:missing_figure')
    })

    it('detects duplicate labels', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        '\\label{sec:intro}',
        '\\section{Methods}',
        '\\label{sec:intro}',
        '\\end{document}',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, check_types: ['labels'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.labelIssueCount).toBeGreaterThan(0)
      expect(result.output).toContain('DUPLICATE')
      expect(result.output).toContain('sec:intro')
    })

    it('detects unused labels', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        '\\label{sec:intro}',
        '\\section{Methods}',
        '\\label{sec:methods}',
        'Only reference intro: \\ref{sec:intro}.',
        '\\end{document}',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, check_types: ['refs'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('UNUSED')
      expect(result.output).toContain('sec:methods')
    })

    it('detects missing citation keys', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\cite{smith2020}',
        '\\cite{nonexistent2021}',
        '\\bibliography{refs}',
        '\\end{document}',
      ].join('\n')

      const bibContent = `@article{smith2020,
  author = {John Smith},
  title = {A Paper},
  year = {2020},
  journal = {Journal}
}
`

      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, path) => {
          if (path === '/main.tex') return 'doc-tex'
          if (path === '/refs.bib') return 'doc-bib'
          return null
        })

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-tex') return { content: texContent, version: 1 }
          if (docId === 'doc-bib') return { content: bibContent, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, check_types: ['cites'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.citeIssueCount).toBeGreaterThan(0)
      expect(result.output).toContain('MISSING')
      expect(result.output).toContain('nonexistent2021')
    })

    it('warns about label naming convention violations', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{figure}',
        '\\label{my_figure}',
        '\\end{figure}',
        '\\begin{table}',
        '\\label{tab:my_table}',
        '\\end{table}',
        '\\section{Introduction}',
        '\\label{introduction}',
        '\\end{document}',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, check_types: ['labels'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.labelIssueCount).toBeGreaterThan(0)
      expect(result.output).toContain('NAMING')
      // my_figure should be flagged (inside figure env but no fig: prefix)
      expect(result.output).toContain('my_figure')
      // introduction should be flagged (after \section but no sec: prefix)
      expect(result.output).toContain('introduction')
      // tab:my_table already follows convention, should NOT be flagged
      expect(result.output).not.toContain('tab:my_table')
    })

    it('reports no issues for a clean project', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        '\\label{sec:intro}',
        'See Section~\\ref{sec:intro}.',
        '\\cite{smith2020}',
        '\\bibliography{refs}',
        '\\end{document}',
      ].join('\n')

      const bibContent = `@article{smith2020,
  author = {John Smith},
  title = {A Paper},
  year = {2020},
  journal = {Journal}
}
`

      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, path) => {
          if (path === '/main.tex') return 'doc-tex'
          if (path === '/refs.bib') return 'doc-bib'
          return null
        })

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-tex') return { content: texContent, version: 1 }
          if (docId === 'doc-bib') return { content: bibContent, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, check_types: ['all'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.totalIssues).toBe(0)
      expect(result.output).toContain('No label issues found')
      expect(result.output).toContain('No reference issues found')
      expect(result.output).toContain('No citation issues found')
    })
  })
})
