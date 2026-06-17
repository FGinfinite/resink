import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @overleaf/settings
vi.mock('@overleaf/settings', () => ({
  default: {
    document: {
      maxLines: 1000,
      maxChars: 50000,
      maxContentLength: 100000,
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

const { ReadDocumentTool } = await import(
  '../../../../app/js/tool/read.js'
)

describe('ReadDocumentTool', () => {
  let tool
  let mockDocumentAdapter
  let mockContext

  beforeEach(() => {
    tool = new ReadDocumentTool()

    mockDocumentAdapter = {
      getDocumentContent: vi.fn(),
      getDocument: vi.fn(),
    }

    mockContext = {
      sessionId: 'session-1',
      projectId: 'proj-1',
      currentDocId: 'doc-1',
      currentDocPath: '/main.tex',
      adapters: {
        document: mockDocumentAdapter,
      },
      sessionState: {
        readDocuments: new Map(),
      },
    }
  })

  it('has correct name "read_document"', () => {
    expect(tool.name).toBe('read_document')
  })

  describe('execute', () => {
    it('returns full document content with line numbers', async () => {
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
        version: 3,
      })

      const result = await tool.execute(
        {},
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('Hello World')
      expect(result.output).toContain('version 3')
      expect(result.data.version).toBe(3)
      expect(result.data.docId).toBe('doc-1')
    })

    it('tracks read documents in sessionState as Map with version', async () => {
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'Content here',
        version: 1,
      })

      await tool.execute(
        {},
        mockContext
      )

      const readInfo = mockContext.sessionState.readDocuments.get('proj-1:doc-1')
      expect(readInfo).toBeDefined()
      expect(readInfo.version).toBe(1)
      expect(readInfo.readAt).toBeGreaterThan(0)
    })

    it('creates readDocuments map if not present', async () => {
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'Content',
        version: 1,
      })

      const contextWithoutMap = {
        ...mockContext,
        sessionState: {},
      }

      await tool.execute(
        {},
        contextWithoutMap
      )

      const readInfo = contextWithoutMap.sessionState.readDocuments.get('proj-1:doc-1')
      expect(readInfo).toBeDefined()
      expect(readInfo.version).toBe(1)
    })

    it('outputs content with line numbers', async () => {
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}',
        version: 3,
      })

      const result = await tool.execute(
        {},
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('1| \\documentclass{article}')
      expect(result.output).toContain('2| \\begin{document}')
      expect(result.output).toContain('3| Hello World')
      expect(result.output).toContain('4| \\end{document}')
      expect(result.output).toContain('total 4 lines')
    })

    it('handles DocumentNotFoundError', async () => {
      const error = new Error('Document not found')
      error.code = 'DOCUMENT_NOT_FOUND'
      mockDocumentAdapter.getDocumentContent.mockRejectedValueOnce(error)

      const result = await tool.execute(
        {},
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('Document not found')
    })

    // --- New tests for offset/limit/heading ---

    describe('offset pagination', () => {
      it('starts reading from offset line', async () => {
        const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`)
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: lines.join('\n'),
          version: 1,
        })

        const result = await tool.execute(
          { offset: 5 },
          mockContext
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('05| Line 5')
        expect(result.output).toContain('10| Line 10')
        expect(result.output).not.toContain('01| Line 1')
      })

      it('returns error when offset exceeds document length', async () => {
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: 'line1\nline2\nline3',
          version: 1,
        })

        const result = await tool.execute(
          { offset: 100 },
          mockContext
        )

        expect(result.success).toBe(false)
        expect(result.output).toContain('exceeds document length')
      })
    })

    describe('limit parameter', () => {
      it('limits output to specified number of lines', async () => {
        const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`)
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: lines.join('\n'),
          version: 1,
        })

        const result = await tool.execute(
          { limit: 10 },
          mockContext
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('Showing 10 of 100 lines')
        expect(result.data.truncated).toBe(true)
      })
    })

    describe('heading parameter', () => {
      it('extracts section by heading name', async () => {
        const content = [
          '\\documentclass{article}',
          '\\begin{document}',
          '\\section{Introduction}',
          'This is the introduction.',
          '\\section{Methods}',
          'This is the methods section.',
          '\\end{document}',
        ].join('\n')

        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content,
          version: 2,
        })

        const result = await tool.execute(
          { heading: 'Introduction' },
          mockContext
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('This is the introduction.')
        expect(result.output).not.toContain('This is the methods section.')
        expect(result.data.heading).toBe('Introduction')
      })

      it('returns error when heading not found', async () => {
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: '\\section{A}\ntext',
          version: 1,
        })

        const result = await tool.execute(
          { heading: 'NonExistent' },
          mockContext
        )

        expect(result.success).toBe(false)
        expect(result.output).toContain('not found')
      })

      it('returns error for heading on non-.tex file', async () => {
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: 'some content',
          version: 1,
        })

        mockContext.currentDocPath = '/refs.bib'

        const result = await tool.execute(
          { heading: 'References' },
          mockContext
        )

        expect(result.success).toBe(false)
        expect(result.output).toContain('only works with .tex files')
      })
    })

    describe('auto-outline on truncation', () => {
      it('includes remaining structure for truncated .tex files', async () => {
        const lines = [
          ...Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`),
          '\\section{Hidden Section}',
          'Hidden content.',
        ]
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: lines.join('\n'),
          version: 1,
        })

        const result = await tool.execute(
          { limit: 5 },
          mockContext
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('Remaining document structure:')
        expect(result.output).toContain('\\section{Hidden Section}')
      })

      it('includes pagination hint when truncated', async () => {
        const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`)
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: lines.join('\n'),
          version: 1,
        })

        const result = await tool.execute(
          { limit: 10 },
          mockContext
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('Use offset=')
        expect(result.output).toContain('to continue reading.')
      })
    })

    describe('line number alignment', () => {
      it('aligns line numbers with offset', async () => {
        const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`)
        mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
          content: lines.join('\n'),
          version: 1,
        })

        const result = await tool.execute(
          { offset: 11, limit: 5 },
          mockContext
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('11| Line 11')
        expect(result.output).toContain('15| Line 15')
      })
    })
  })
})
