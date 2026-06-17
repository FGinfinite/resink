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

const { SearchProjectTool } = await import(
  '../../../../app/js/tool/search.js'
)

describe('SearchProjectTool', () => {
  let tool
  let mockDocumentAdapter
  let mockProjectAdapter
  let mockContext

  beforeEach(() => {
    tool = new SearchProjectTool()

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

  it('has correct name "search_project"', () => {
    expect(tool.name).toBe('search_project')
  })

  describe('execute', () => {
    it('returns error for invalid regex', async () => {
      const result = await tool.execute(
        { pattern: '[invalid' },
        mockContext
      )
      expect(result.success).toBe(false)
      expect(result.output).toContain('Invalid regex')
    })

    it('searches single file when path specified', async () => {
      mockProjectAdapter.resolvePathToDocId.mockResolvedValueOnce('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'line one\nfind me here\nline three',
        version: 1,
      })

      const result = await tool.execute(
        { pattern: 'find me', path: 'main.tex' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('find me here')
      expect(result.data.matchCount).toBe(1)
    })

    it('searches all docs when no path specified', async () => {
      mockProjectAdapter.listFiles.mockResolvedValueOnce([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-1' },
        { path: '/refs.bib', name: 'refs.bib', type: 'doc', docId: 'doc-2' },
      ])

      mockDocumentAdapter.getDocumentContent
        .mockResolvedValueOnce({ content: 'hello world\nfoo bar', version: 1 })
        .mockResolvedValueOnce({ content: 'no match here\nbaz qux', version: 1 })

      const result = await tool.execute(
        { pattern: 'hello' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.matchCount).toBe(1)
      expect(result.data.fileCount).toBe(1)
    })

    it('returns no matches message', async () => {
      mockProjectAdapter.listFiles.mockResolvedValueOnce([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-1' },
      ])
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'nothing here',
        version: 1,
      })

      const result = await tool.execute(
        { pattern: 'nonexistent' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('No matches found')
      expect(result.data.matchCount).toBe(0)
    })

    it('filters by glob pattern', async () => {
      mockProjectAdapter.listFiles.mockResolvedValueOnce([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-1' },
        { path: '/refs.bib', name: 'refs.bib', type: 'doc', docId: 'doc-2' },
      ])

      mockDocumentAdapter.getDocumentContent
        .mockResolvedValueOnce({ content: 'author = Smith', version: 1 })

      const result = await tool.execute(
        { pattern: 'author', glob: '*.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      // Should only search .bib files
      expect(mockDocumentAdapter.getDocumentContent).toHaveBeenCalledTimes(1)
    })

    it('shows context lines around matches', async () => {
      mockProjectAdapter.resolvePathToDocId.mockResolvedValueOnce('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'line 1\nline 2\nMATCH HERE\nline 4\nline 5',
        version: 1,
      })

      const result = await tool.execute(
        { pattern: 'MATCH', path: 'test.tex', context_lines: 1 },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('line 2')
      expect(result.output).toContain('MATCH HERE')
      expect(result.output).toContain('line 4')
    })

    it('marks matching lines with > prefix', async () => {
      mockProjectAdapter.resolvePathToDocId.mockResolvedValueOnce('doc-1')
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'before\ntarget line\nafter',
        version: 1,
      })

      const result = await tool.execute(
        { pattern: 'target', path: 'test.tex', context_lines: 0 },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toMatch(/>.*target line/)
    })

    it('returns error when path not found', async () => {
      mockProjectAdapter.resolvePathToDocId.mockResolvedValueOnce(null)

      const result = await tool.execute(
        { pattern: 'test', path: 'missing.tex' },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('File not found')
    })

    it('skips files that fail to read', async () => {
      mockProjectAdapter.listFiles.mockResolvedValueOnce([
        { path: '/good.tex', name: 'good.tex', type: 'doc', docId: 'doc-1' },
        { path: '/bad.tex', name: 'bad.tex', type: 'doc', docId: 'doc-2' },
      ])

      mockDocumentAdapter.getDocumentContent
        .mockResolvedValueOnce({ content: 'match here', version: 1 })
        .mockRejectedValueOnce(new Error('read failed'))

      const result = await tool.execute(
        { pattern: 'match' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.matchCount).toBe(1)
    })

    it('searches multiple files and combines results', async () => {
      mockProjectAdapter.listFiles.mockResolvedValueOnce([
        { path: '/a.tex', name: 'a.tex', type: 'doc', docId: 'doc-1' },
        { path: '/b.tex', name: 'b.tex', type: 'doc', docId: 'doc-2' },
      ])

      mockDocumentAdapter.getDocumentContent
        .mockResolvedValueOnce({ content: 'TODO: fix\nother line', version: 1 })
        .mockResolvedValueOnce({ content: 'line\nTODO: update\nmore', version: 1 })

      const result = await tool.execute(
        { pattern: 'TODO' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.matchCount).toBe(2)
      expect(result.data.fileCount).toBe(2)
      expect(result.output).toContain('/a.tex')
      expect(result.output).toContain('/b.tex')
    })
  })
})
