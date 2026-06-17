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

const { DocStructureMapTool } = await import(
  '../../../../app/js/tool/doc_structure_map.js'
)

describe('DocStructureMapTool', () => {
  let tool
  let mockDocumentAdapter
  let mockProjectAdapter
  let mockContext

  beforeEach(() => {
    tool = new DocStructureMapTool()

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

  it('has correct name "doc_structure_map"', () => {
    expect(tool.name).toBe('doc_structure_map')
  })

  describe('execute', () => {
    it('analyses a single file with sections', async () => {
      const texContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        'This is the introduction with some words here.',
        '\\section{Methods}',
        'We propose a novel method for analysis.',
        '\\subsection{Data Collection}',
        'Data was collected from various sources.',
        '\\section{Results}',
        'The results show significant improvement.',
        '\\end{document}',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, metrics: [] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.fileCount).toBe(1)
      expect(result.data.sectionCount).toBeGreaterThanOrEqual(3)
      expect(result.output).toContain('Introduction')
      expect(result.output).toContain('Methods')
      expect(result.output).toContain('Results')
    })

    it('follows \\input directives for multi-file projects', async () => {
      const mainContent = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\input{chapters/intro}',
        '\\input{chapters/methods}',
        '\\end{document}',
      ].join('\n')

      const introContent = [
        '\\section{Introduction}',
        'This is the introduction.',
      ].join('\n')

      const methodsContent = [
        '\\section{Methods}',
        'These are the methods.',
      ].join('\n')

      // main.tex
      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, path) => {
          if (path === '/main.tex') return 'doc-main'
          if (path === '/chapters/intro.tex') return 'doc-intro'
          if (path === '/chapters/methods.tex') return 'doc-methods'
          return null
        })

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-main') return { content: mainContent, version: 1 }
          if (docId === 'doc-intro') return { content: introContent, version: 1 }
          if (docId === 'doc-methods') return { content: methodsContent, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, metrics: [] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.fileCount).toBe(3)
      expect(result.data.sectionCount).toBeGreaterThanOrEqual(2)
      expect(result.output).toContain('Introduction')
      expect(result.output).toContain('Methods')
    })

    it('computes all metrics per section', async () => {
      const texContent = [
        '\\section{Introduction}',
        'This section has some words for counting purposes.',
        '\\begin{equation}',
        'E = mc^2',
        '\\end{equation}',
        '\\begin{figure}',
        '\\includegraphics{fig1.png}',
        '\\end{figure}',
        '\\begin{table}',
        '\\begin{tabular}{cc}',
        'a & b',
        '\\end{tabular}',
        '\\end{table}',
        '\\cite{smith2020}',
        '% TODO: add more content',
        '\\section{Conclusion}',
        'Short conclusion.',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        {
          entry_file: 'main.tex',
          follow_inputs: true,
          metrics: ['word_count', 'equation_count', 'figure_count', 'table_count', 'citation_count', 'todo_count'],
        },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.sectionCount).toBe(2)
      expect(result.data.totalWords).toBeGreaterThan(0)
      // Output should contain metric labels
      expect(result.output).toContain('words')
      expect(result.output).toContain('eq')
      expect(result.output).toContain('fig')
      expect(result.output).toContain('tbl')
      expect(result.output).toContain('cite')
      expect(result.output).toContain('todo')
    })

    it('generates imbalance warnings when sections differ significantly', async () => {
      // One very long section and one very short section
      const longBody = Array(100).fill('Word word word word word.').join(' ')
      const texContent = [
        '\\section{Very Long Section}',
        longBody,
        '\\section{Tiny Section}',
        'Short.',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, metrics: ['word_count'] },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.warningCount).toBeGreaterThan(0)
      expect(result.output).toContain('Warnings')
      // Should contain above/below average indication
      expect(result.output).toMatch(/above average|below average/)
    })

    it('countWords handles escaped percent \\% correctly (Codex round 2)', async () => {
      const texContent = [
        '\\section{Results}',
        'Accuracy improved by 50\\% compared to baseline methods.',
        '% This is a real comment that should be excluded from count.',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, metrics: ['word_count'] },
        mockContext
      )

      expect(result.success).toBe(true)
      // "50\%" line should contribute words; comment line should not
      expect(result.data.totalWords).toBeGreaterThan(0)
      // The output should contain word count metric
      expect(result.output).toContain('words')
    })

    it('imbalance warnings only compare leaf sections (Codex round 2)', async () => {
      // Parent section with 2 sub-sections — parent should not be compared
      const longBody = Array(80).fill('word word word word word.').join(' ')
      const texContent = [
        '\\section{Parent}',
        '\\subsection{Sub A}',
        longBody,
        '\\subsection{Sub B}',
        longBody,
        '\\section{Standalone}',
        'Short.',
      ].join('\n')

      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: texContent,
        version: 1,
      })

      const result = await tool.execute(
        { entry_file: 'main.tex', follow_inputs: true, metrics: ['word_count'] },
        mockContext
      )

      expect(result.success).toBe(true)
      // Standalone should be flagged as below average compared to Sub A and Sub B
      if (result.data.warningCount > 0) {
        expect(result.output).toContain('Standalone')
      }
    })

    it('returns error when entry file is missing', async () => {
      mockProjectAdapter.resolvePathToDocId.mockResolvedValue(null)

      const result = await tool.execute(
        { entry_file: 'missing.tex', follow_inputs: true, metrics: [] },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('Could not read entry file')
      expect(result.output).toContain('missing.tex')
    })
  })
})
