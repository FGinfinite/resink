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

const { BibManageTool } = await import(
  '../../../../app/js/tool/bib_manage.js'
)

describe('BibManageTool', () => {
  let tool
  let mockDocumentAdapter
  let mockProjectAdapter
  let mockContext

  const SAMPLE_BIB = `@article{smith2020,
  author = {John Smith},
  title = {A Great Paper},
  year = {2020},
  journal = {Journal of Testing},
  doi = {10.1234/test.2020}
}

@inproceedings{doe2021,
  author = {Jane Doe},
  title = {Conference Paper},
  year = {2021},
  booktitle = {Proceedings of TestConf}
}

@article{jones2019,
  title = {Missing Author Paper},
  year = {2019},
  journal = {Some Journal}
}
`

  const SAMPLE_TEX = `\\documentclass{article}
\\begin{document}
\\cite{smith2020}
\\cite{doe2021}
\\cite{nonexistent_key}
\\bibliography{refs}
\\end{document}
`

  beforeEach(() => {
    tool = new BibManageTool()

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

  it('has correct name "bib_manage"', () => {
    expect(tool.name).toBe('bib_manage')
  })

  describe('validate action', () => {
    it('finds entries with missing required fields', async () => {
      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-bib')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: SAMPLE_BIB,
        version: 1,
      })

      const result = await tool.execute(
        { action: 'validate', bib_path: '/refs.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      // jones2019 is missing "author"
      expect(result.data.issueCount).toBeGreaterThan(0)
      expect(result.output).toContain('jones2019')
      expect(result.output).toContain('missing')
      expect(result.output).toContain('author')
    })
  })

  describe('dedupe action', () => {
    it('finds duplicate entries by DOI', async () => {
      const bibWithDupes = `@article{smith2020a,
  author = {John Smith},
  title = {A Great Paper},
  year = {2020},
  journal = {Journal of Testing},
  doi = {10.1234/test.2020}
}

@article{smith2020b,
  author = {J. Smith},
  title = {A Great Paper (Copy)},
  year = {2020},
  journal = {Journal of Testing},
  doi = {10.1234/test.2020}
}
`
      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-bib')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: bibWithDupes,
        version: 1,
      })

      const result = await tool.execute(
        { action: 'dedupe', bib_path: '/refs.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.duplicateGroups).toBeGreaterThan(0)
      expect(result.output).toContain('smith2020a')
      expect(result.output).toContain('smith2020b')
      expect(result.output).toContain('same DOI')
    })
  })

  describe('find_unused action', () => {
    it('detects bib entries not cited in any tex file', async () => {
      // listFiles returns both tex and bib files
      mockProjectAdapter.listFiles.mockResolvedValue([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-tex' },
        { path: '/refs.bib', name: 'refs.bib', type: 'doc', docId: 'doc-bib' },
      ])

      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, path) => {
          if (path === '/refs.bib') return 'doc-bib'
          if (path === '/main.tex') return 'doc-tex'
          return null
        })

      // main.tex only cites smith2020 — doe2021 and jones2019 are unused
      const texOnlyCiteSmith = `\\documentclass{article}
\\begin{document}
\\cite{smith2020}
\\bibliography{refs}
\\end{document}
`

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-bib') return { content: SAMPLE_BIB, version: 1 }
          if (docId === 'doc-tex') return { content: texOnlyCiteSmith, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { action: 'find_unused', bib_path: '/refs.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.unusedCount).toBe(2)
      expect(result.data.unusedKeys).toContain('doe2021')
      expect(result.data.unusedKeys).toContain('jones2019')
      expect(result.output).toContain('doe2021')
      expect(result.output).toContain('jones2019')
    })
  })

  describe('find_missing action', () => {
    it('detects citation keys with no matching bib entry', async () => {
      mockProjectAdapter.listFiles.mockResolvedValue([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-tex' },
        { path: '/refs.bib', name: 'refs.bib', type: 'doc', docId: 'doc-bib' },
      ])

      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, path) => {
          if (path === '/refs.bib') return 'doc-bib'
          if (path === '/main.tex') return 'doc-tex'
          return null
        })

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-bib') return { content: SAMPLE_BIB, version: 1 }
          if (docId === 'doc-tex') return { content: SAMPLE_TEX, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { action: 'find_missing', bib_path: '/refs.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.missingCount).toBeGreaterThan(0)
      expect(result.data.missingKeys).toContain('nonexistent_key')
      expect(result.output).toContain('nonexistent_key')
    })
  })

  describe('normalize action', () => {
    it('shows normalization preview for entries with changes', async () => {
      const bibWithUnnormalized = `@article{smith2020,
  author = {John Smith},
  title = {A Great Paper},
  year = {2020},
  journal = {Journal of Testing},
  month = {January},
  doi = {https://doi.org/10.1234/test.2020}
}
`
      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-bib')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: bibWithUnnormalized,
        version: 1,
      })

      const result = await tool.execute(
        { action: 'normalize', bib_path: '/refs.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.changeCount).toBeGreaterThan(0)
      expect(result.output).toContain('smith2020')
      // Month should be normalized from January to jan
      expect(result.output).toContain('month')
      // DOI should have prefix stripped
      expect(result.output).toContain('doi')
    })
  })

  describe('sort action', () => {
    it('shows sort preview when entries are not alphabetical', async () => {
      const bibUnsorted = `@article{zebra2020,
  author = {Zara Zebra},
  title = {Zebra Paper},
  year = {2020},
  journal = {Zoo Journal}
}

@article{alpha2019,
  author = {Alice Alpha},
  title = {Alpha Paper},
  year = {2019},
  journal = {Alpha Journal}
}
`
      mockProjectAdapter.resolvePathToDocId.mockResolvedValue('doc-bib')
      mockDocumentAdapter.getDocumentContent.mockResolvedValue({
        content: bibUnsorted,
        version: 1,
      })

      const result = await tool.execute(
        { action: 'sort', bib_path: '/refs.bib' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.alreadySorted).toBe(false)
      expect(result.data.entryCount).toBe(2)
      // alpha2019 should come before zebra2020
      expect(result.data.newOrder[0]).toBe('alpha2019')
      expect(result.data.newOrder[1]).toBe('zebra2020')
      expect(result.output).toContain('Sort preview')
    })
  })

  describe('auto-detect bib path', () => {
    it('finds bib path from \\bibliography command in tex files', async () => {
      mockProjectAdapter.listFiles.mockResolvedValue([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-tex' },
        { path: '/refs.bib', name: 'refs.bib', type: 'doc', docId: 'doc-bib' },
      ])

      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, path) => {
          if (path === '/refs.bib') return 'doc-bib'
          if (path === '/main.tex') return 'doc-tex'
          return null
        })

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-tex') return { content: SAMPLE_TEX, version: 1 }
          if (docId === 'doc-bib') return { content: SAMPLE_BIB, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { action: 'validate' },
        mockContext
      )

      expect(result.success).toBe(true)
      // Should have auto-detected /refs.bib and run validation
      expect(result.data.entryCount).toBe(3)
    })
  })

  describe('multi-bib file support (Codex review)', () => {
    it('auto-detects and merges entries from multiple .bib files', async () => {
      const bib1 = `@article{Smith2020,
  author = {Smith},
  title = {Paper One},
  year = {2020},
  journal = {Nature}
}`
      const bib2 = `@article{Jones2021,
  author = {Jones},
  title = {Paper Two},
  year = {2021},
  journal = {Science}
}`
      mockProjectAdapter.listFiles.mockResolvedValue([
        { path: '/main.tex', name: 'main.tex', type: 'doc', docId: 'doc-tex' },
        { path: '/refs1.bib', name: 'refs1.bib', type: 'doc', docId: 'doc-bib1' },
        { path: '/refs2.bib', name: 'refs2.bib', type: 'doc', docId: 'doc-bib2' },
      ])

      mockProjectAdapter.resolvePathToDocId
        .mockImplementation(async (_projId, p) => {
          if (p === '/main.tex') return 'doc-tex'
          if (p === '/refs1.bib') return 'doc-bib1'
          if (p === '/refs2.bib') return 'doc-bib2'
          return null
        })

      mockDocumentAdapter.getDocumentContent
        .mockImplementation(async (_projId, docId) => {
          if (docId === 'doc-tex') {
            return { content: '\\bibliography{refs1,refs2}', version: 1 }
          }
          if (docId === 'doc-bib1') return { content: bib1, version: 1 }
          if (docId === 'doc-bib2') return { content: bib2, version: 1 }
          throw new Error('not found')
        })

      const result = await tool.execute(
        { action: 'validate' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.entryCount).toBe(2)
    })
  })
})
