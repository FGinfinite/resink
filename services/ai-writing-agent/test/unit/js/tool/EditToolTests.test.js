import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @overleaf/settings
vi.mock('@overleaf/settings', () => ({
  default: {},
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

const { EditDocumentTool } = await import(
  '../../../../app/js/tool/edit.js'
)
const { EditMatchError } = await import(
  '../../../../app/js/adapter/DocumentAdapter.js'
)

describe('EditDocumentTool', () => {
  let tool
  let mockDocumentAdapter
  let mockContext

  beforeEach(() => {
    tool = new EditDocumentTool()

    mockDocumentAdapter = {
      getDocumentContent: vi.fn(),
      previewEdit: vi.fn(),
      positionToLineColumn: vi.fn(),
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

  it('has correct name "edit_document"', () => {
    expect(tool.name).toBe('edit_document')
  })

  describe('execute', () => {
    it('enforces read-before-write (returns error if doc not read)', async () => {
      // Document NOT in readDocuments map
      const result = await tool.execute(
        {
          oldText: 'old',
          newText: 'new',
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('must read the document first')
      expect(mockDocumentAdapter.previewEdit).not.toHaveBeenCalled()
    })

    it('allows edit after reading', async () => {
      // Mark document as read
      mockContext.sessionState.readDocuments.set('proj-1:doc-1', {
        version: 5,
        readAt: Date.now(),
      })

      const pendingChange = {
        id: 'change-123',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 10, end: 20 },
        oldText: 'old text',
        newText: 'new text',
        status: 'pending',
        createdAt: Date.now(),
      }

      mockDocumentAdapter.previewEdit.mockResolvedValueOnce(pendingChange)
      // Version check call
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'Some pre old text post content',
        version: 5,
      })
      // Line number calculation call
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'Some pre old text post content',
        version: 5,
      })
      mockDocumentAdapter.positionToLineColumn
        .mockReturnValueOnce({ line: 1, column: 11 })
        .mockReturnValueOnce({ line: 1, column: 21 })

      const result = await tool.execute(
        {
          oldText: 'old text',
          newText: 'new text',
        },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('change-123')
      expect(result.data.needsConfirmation).toBe(true)
      expect(result.data.change).toEqual(pendingChange)
    })

    it('rejects identical oldText/newText', async () => {
      mockContext.sessionState.readDocuments.set('proj-1:doc-1', {
        version: 5,
        readAt: Date.now(),
      })

      const result = await tool.execute(
        {
          oldText: 'same text',
          newText: 'same text',
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('identical')
    })

    it('rejects empty oldText', async () => {
      mockContext.sessionState.readDocuments.set('proj-1:doc-1', {
        version: 5,
        readAt: Date.now(),
      })

      const result = await tool.execute(
        {
          oldText: '   ',
          newText: 'something',
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('cannot be empty')
    })

    it('creates pending change', async () => {
      mockContext.sessionState.readDocuments.set('proj-1:doc-1', {
        version: 3,
        readAt: Date.now(),
      })

      const pendingChange = {
        id: 'change-456',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 3,
        position: { start: 5, end: 15 },
        oldText: 'Hello',
        newText: 'World',
        status: 'pending',
        createdAt: Date.now(),
      }

      mockDocumentAdapter.previewEdit.mockResolvedValueOnce(pendingChange)
      // Version check call
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'Some Hello And More',
        version: 3,
      })
      // Line number calculation call
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'Some Hello And More',
        version: 3,
      })
      mockDocumentAdapter.positionToLineColumn
        .mockReturnValueOnce({ line: 1, column: 6 })
        .mockReturnValueOnce({ line: 1, column: 16 })

      const result = await tool.execute(
        {
          oldText: 'Hello',
          newText: 'World',
        },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.changeId).toBe('change-456')
    })

    it('handles EditMatchError', async () => {
      mockContext.sessionState.readDocuments.set('proj-1:doc-1', {
        version: 5,
        readAt: Date.now(),
      })

      mockDocumentAdapter.previewEdit.mockRejectedValueOnce(
        new EditMatchError('Cannot find text to replace: "nonexistent"')
      )

      const result = await tool.execute(
        {
          oldText: 'nonexistent',
          newText: 'replacement',
        },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('Could not find the specified text')
    })

    it('returns needsConfirmation with change data', async () => {
      mockContext.sessionState.readDocuments.set('proj-1:doc-1', {
        version: 7,
        readAt: Date.now(),
      })

      const pendingChange = {
        id: 'change-789',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 7,
        position: { start: 0, end: 5 },
        oldText: 'alpha',
        newText: 'beta',
        status: 'pending',
        createdAt: Date.now(),
      }

      mockDocumentAdapter.previewEdit.mockResolvedValueOnce(pendingChange)
      // Version check call
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'alpha gamma delta',
        version: 7,
      })
      // Line number calculation call
      mockDocumentAdapter.getDocumentContent.mockResolvedValueOnce({
        content: 'alpha gamma delta',
        version: 7,
      })
      mockDocumentAdapter.positionToLineColumn
        .mockReturnValueOnce({ line: 1, column: 1 })
        .mockReturnValueOnce({ line: 1, column: 6 })

      const result = await tool.execute(
        {
          oldText: 'alpha',
          newText: 'beta',
        },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.needsConfirmation).toBe(true)
      expect(result.data.change).toEqual(pendingChange)
      expect(result.data.changeId).toBe('change-789')
    })
  })
})
