import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @overleaf/settings
vi.mock('@overleaf/settings', () => ({
  default: {
    apis: {
      documentUpdater: { url: 'http://doc-updater:3003' },
      web: { url: 'http://web:3000' },
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

const {
  DocumentAdapter,
} = await import(
  '../../../../app/js/adapter/DocumentAdapter.js'
)

// Helper: create a mock fetch Response
function createMockResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

describe('DocumentAdapter', () => {
  let adapter
  let mockFetch

  beforeEach(() => {
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    adapter = new DocumentAdapter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('getDocument', () => {
    it('calls correct URL and returns parsed response', async () => {
      const responseBody = {
        lines: ['\\documentclass{article}', '\\begin{document}', 'Hello', '\\end{document}'],
        version: 42,
        ranges: { comments: [] },
      }

      mockFetch.mockResolvedValueOnce(createMockResponse(responseBody))

      const result = await adapter.getDocument('proj-1', 'doc-1')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      const callUrl = mockFetch.mock.calls[0][0]
      expect(callUrl).toBe('http://doc-updater:3003/project/proj-1/doc/doc-1')

      expect(result.lines).toEqual(responseBody.lines)
      expect(result.version).toBe(42)
      expect(result.ranges).toEqual({ comments: [] })
    })

    it('throws DocumentNotFoundError on 404', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse('Not found', { status: 404 })
      )

      try {
        await adapter.getDocument('proj-1', 'doc-missing')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('DocumentNotFoundError')
      }
    })

    it('returns defaults for missing fields', async () => {
      const responseBody = {}
      mockFetch.mockResolvedValueOnce(createMockResponse(responseBody))

      const result = await adapter.getDocument('proj-1', 'doc-1')

      expect(result.lines).toEqual([])
      expect(result.version).toBe(0)
      expect(result.ranges).toEqual({})
    })
  })

  describe('getDocumentContent', () => {
    it('joins lines correctly', async () => {
      const responseBody = {
        lines: ['Line 1', 'Line 2', 'Line 3'],
        version: 5,
        ranges: {},
      }

      mockFetch.mockResolvedValueOnce(createMockResponse(responseBody))

      const result = await adapter.getDocumentContent('proj-1', 'doc-1')

      expect(result.content).toBe('Line 1\nLine 2\nLine 3')
      expect(result.version).toBe(5)
    })
  })

  describe('previewEdit', () => {
    it('generates correct pending change', async () => {
      const responseBody = {
        lines: ['Hello World', 'Replace Me', 'End'],
        version: 10,
        ranges: {},
      }

      mockFetch.mockResolvedValueOnce(createMockResponse(responseBody))

      const change = await adapter.previewEdit(
        'proj-1',
        'doc-1',
        'Replace Me',
        'Replaced!'
      )

      expect(change.projectId).toBe('proj-1')
      expect(change.docId).toBe('doc-1')
      expect(change.baseVersion).toBe(10)
      expect(change.oldText).toBe('Replace Me')
      expect(change.newText).toBe('Replaced!')
      expect(change.status).toBe('pending')
      expect(change.position.start).toBe(12)
      expect(change.position.end).toBe(22)
      expect(change.id).toBeDefined()
      expect(change.createdAt).toBeDefined()
    })

    it('throws EditMatchError when text not found', async () => {
      const responseBody = {
        lines: ['Hello World'],
        version: 1,
        ranges: {},
      }

      mockFetch.mockResolvedValueOnce(createMockResponse(responseBody))

      try {
        await adapter.previewEdit('proj-1', 'doc-1', 'Not found text', 'New text')
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('EditMatchError')
      }
    })
  })

  describe('buildOTOps', () => {
    it('generates correct OT operations', () => {
      const position = { start: 5, end: 10 }
      const ops = adapter.buildOTOps(position, 'world', 'earth')

      expect(ops).toHaveLength(3)

      // Retain
      expect(ops[0]).toEqual({ p: 5, r: 5 })
      // Delete
      expect(ops[1]).toEqual({ p: 5, d: 'world' })
      // Insert
      expect(ops[2]).toEqual({ p: 5, i: 'earth' })
    })

    it('omits retain when position starts at 0', () => {
      const position = { start: 0, end: 3 }
      const ops = adapter.buildOTOps(position, 'foo', 'bar')

      // Should not have a retain operation (start is 0)
      expect(ops).toHaveLength(2)
      expect(ops[0]).toEqual({ p: 0, d: 'foo' })
      expect(ops[1]).toEqual({ p: 0, i: 'bar' })
    })

    it('handles empty oldText (insert only)', () => {
      const position = { start: 5, end: 5 }
      const ops = adapter.buildOTOps(position, '', 'inserted')

      // retain + insert (no delete because old is empty)
      expect(ops).toHaveLength(2)
      expect(ops[0]).toEqual({ p: 5, r: 5 })
      expect(ops[1]).toEqual({ p: 5, i: 'inserted' })
    })

    it('handles empty newText (delete only)', () => {
      const position = { start: 5, end: 10 }
      const ops = adapter.buildOTOps(position, 'hello', '')

      // retain + delete (no insert because new is empty)
      expect(ops).toHaveLength(2)
      expect(ops[0]).toEqual({ p: 5, r: 5 })
      expect(ops[1]).toEqual({ p: 5, d: 'hello' })
    })
  })

  describe('positionToLineColumn', () => {
    it('converts correctly', () => {
      const content = 'Hello\nWorld\nFoo'

      // Position 0 = line 1, column 1
      expect(adapter.positionToLineColumn(content, 0)).toEqual({
        line: 1,
        column: 1,
      })

      // Position 6 = line 2, column 1 (start of "World")
      expect(adapter.positionToLineColumn(content, 6)).toEqual({
        line: 2,
        column: 1,
      })

      // Position 8 = line 2, column 3 (the "r" in "World")
      expect(adapter.positionToLineColumn(content, 8)).toEqual({
        line: 2,
        column: 3,
      })

      // Position 12 = line 3, column 1 (start of "Foo")
      expect(adapter.positionToLineColumn(content, 12)).toEqual({
        line: 3,
        column: 1,
      })
    })
  })

  describe('lineColumnToPosition', () => {
    it('converts correctly', () => {
      const content = 'Hello\nWorld\nFoo'

      // Line 1, Column 1 = position 0
      expect(adapter.lineColumnToPosition(content, 1, 1)).toBe(0)

      // Line 2, Column 1 = position 6
      expect(adapter.lineColumnToPosition(content, 2, 1)).toBe(6)

      // Line 2, Column 3 = position 8
      expect(adapter.lineColumnToPosition(content, 2, 3)).toBe(8)

      // Line 3, Column 1 = position 12
      expect(adapter.lineColumnToPosition(content, 3, 1)).toBe(12)
    })
  })
})
