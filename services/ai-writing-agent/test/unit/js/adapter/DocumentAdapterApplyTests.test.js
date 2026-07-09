import crypto from 'node:crypto'
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
} = await import('../../../../app/js/adapter/DocumentAdapter.js')

// Helper: create a mock fetch Response
function createMockResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

describe('DocumentAdapter.applyEdit', () => {
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

  describe('basic application', () => {
    it('applies edit when version matches', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 10,
        position: { start: 6, end: 11 },
        oldText: 'World',
        newText: 'Earth',
        status: 'pending',
      }

      // Mock getDocument response
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 10,
          ranges: {},
        })
      )

      // Mock setDoc response
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)
      expect(result.newVersion).toBe(11)
      expect(result.wasRebased).toBe(false)
    })

    it('calls setDoc API with correct parameters', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
        status: 'pending',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      await adapter.applyEdit(change, { userId: 'user-123' })

      expect(mockFetch).toHaveBeenCalledTimes(2)

      // Check setDoc call
      const setDocCall = mockFetch.mock.calls[1]
      expect(setDocCall[0]).toBe('http://doc-updater:3003/project/proj-1/doc/doc-1')
      expect(setDocCall[1].method).toBe('POST')

      const body = JSON.parse(setDocCall[1].body)
      expect(body.lines).toEqual(['Hi World'])
      expect(body.source).toEqual({ kind: 'ai-agent' })
      expect(body.user_id).toBe('user-123')
    })

    it('throws ApplyEditError when userId is missing', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      try {
        await adapter.applyEdit(change, {})
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('ApplyEditError')
      }
    })
  })

  describe('version checking', () => {
    it('detects version mismatch and triggers rebase', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 6, end: 11 },
        oldText: 'World',
        newText: 'Earth',
      }

      // Document version increased but text is still there
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World Again'],
          version: 8,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.wasRebased).toBe(true)
    })

    it('throws VersionConflictError when current version is older', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 10,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello'],
          version: 5, // Older than baseVersion
          ranges: {},
        })
      )

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('VersionConflictError')
      }
    })

    it('throws RebaseConflictError when live document changed after workspace sync', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 11 },
        oldText: 'Hello World',
        newText: 'Hello Earth',
        liveConflictBase: {
          baseVersion: 5,
          oldSha256: sha256('Hello World'),
          path: '/main.tex',
        },
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello External'],
          version: 6,
          ranges: {},
        })
      )

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('RebaseConflictError')
        expect(error.info.conflictType).toBe('LIVE_CONTENT_CHANGED')
        expect(error.info.liveBaseVersion).toBe(5)
      }
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('allows workspace edit when live version advanced but content still matches sync base', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 11 },
        oldText: 'Hello World',
        newText: 'Hello Earth',
        liveConflictBase: {
          baseVersion: 5,
          oldSha256: sha256('Hello World'),
          path: '/main.tex',
        },
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 6,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)
      expect(result.wasRebased).toBe(true)
      const setDocBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(setDocBody.lines).toEqual(['Hello Earth'])
    })
  })

  describe('rebase mechanism', () => {
    it('rebases when oldText exists but position shifted within range', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      // Text moved due to prefix insertion
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Prefix Hello World'],
          version: 8,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)
      expect(result.wasRebased).toBe(true)

      // Verify the new content
      const setDocBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(setDocBody.lines).toEqual(['Prefix Hi World'])
    })

    it('succeeds rebase when position shifted far but oldText is unique (findMatch)', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      // Text moved far — new algorithm uses findMatch which handles unique matches regardless of distance
      const prefix = 'x'.repeat(1100)
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: [prefix + 'Hello World'],
          version: 8,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)
      expect(result.wasRebased).toBe(true)

      const setDocBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(setDocBody.lines).toEqual([prefix + 'Hi World'])
    })

    it('fails rebase when oldText was deleted', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 6, end: 11 },
        oldText: 'World',
        newText: 'Earth',
      }

      // The text "World" no longer exists
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello Universe'],
          version: 8,
          ranges: {},
        })
      )

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('RebaseConflictError')
      }
    })
  })

  describe('content validation', () => {
    it('throws RebaseConflictError when oldText not found in document', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 10,
        position: { start: 6, end: 11 },
        oldText: 'World',
        newText: 'Earth',
      }

      // Content changed — "World" no longer exists anywhere
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello Mars!'],
          version: 10,
          ranges: {},
        })
      )

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        // New algorithm: version matches but position content differs,
        // falls through to findMatch which can't find "World" → RebaseConflictError (NOT_FOUND)
        expect(error.name).toBe('RebaseConflictError')
      }
    })
  })

  describe('API error handling', () => {
    it('handles 406 document too large', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(
        createMockResponse('Document too large', { status: 406 })
      )

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('ApplyEditError')
      }
    })

    it('handles 500 server error', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(
        createMockResponse('Internal error', { status: 500 })
      )

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('ApplyEditError')
      }
    })

    it('handles network timeout', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: 'Hi',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'))

      try {
        await adapter.applyEdit(change, { userId: 'user-1' })
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.name).toBe('ApplyEditError')
      }
    })
  })

  describe('edge cases', () => {
    it('handles empty newText (deletion)', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 5, end: 11 },
        oldText: ' World',
        newText: '',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)

      const setDocBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(setDocBody.lines).toEqual(['Hello'])
    })

    it('handles multi-line content', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 6, end: 11 },
        oldText: 'World',
        newText: 'Beautiful\nWorld',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)

      const setDocBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(setDocBody.lines).toEqual(['Hello Beautiful', 'World'])
    })

    it('handles Unicode content', async () => {
      const change = {
        id: 'change-1',
        projectId: 'proj-1',
        docId: 'doc-1',
        baseVersion: 5,
        position: { start: 0, end: 5 },
        oldText: 'Hello',
        newText: '你好',
      }

      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          lines: ['Hello World'],
          version: 5,
          ranges: {},
        })
      )
      mockFetch.mockResolvedValueOnce(createMockResponse({}))

      const result = await adapter.applyEdit(change, { userId: 'user-1' })

      expect(result.success).toBe(true)

      const setDocBody = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(setDocBody.lines).toEqual(['你好 World'])
    })
  })
})

describe('DocumentAdapter._resolveChangePosition', () => {
  let adapter

  beforeEach(() => {
    adapter = new DocumentAdapter()
  })

  it('uses exact_position when version matches and position is valid', () => {
    const change = {
      oldText: 'World',
      position: { start: 6, end: 11 },
      baseVersion: 5,
    }
    const currentDoc = { content: 'Hello World', version: 5 }

    const result = adapter._resolveChangePosition(change, currentDoc)

    expect(result.success).toBe(true)
    expect(result.method).toBe('exact_position')
  })

  it('uses findMatch_unique when version differs but text is unique', () => {
    const change = {
      oldText: 'World',
      position: { start: 6, end: 11 },
      baseVersion: 5,
    }
    const currentDoc = { content: 'Prefix Hello World', version: 8 }

    const result = adapter._resolveChangePosition(change, currentDoc)

    expect(result.success).toBe(true)
    expect(result.method).toBe('findMatch_unique')
    expect(result.resolvedChange.position.start).toBe(13)
  })

  it('returns NOT_FOUND when oldText no longer exists', () => {
    const change = {
      oldText: 'World',
      position: { start: 6, end: 11 },
      baseVersion: 5,
    }
    const currentDoc = { content: 'Hello Universe', version: 8 }

    const result = adapter._resolveChangePosition(change, currentDoc)

    expect(result.success).toBe(false)
    expect(result.conflictType).toBe('NOT_FOUND')
  })

  it('handles replaceAll changes with position null', () => {
    const change = {
      oldText: 'foo',
      newText: 'bar',
      position: null,
      replaceAll: true,
      baseVersion: 5,
    }
    const currentDoc = { content: 'foo and foo again', version: 8 }

    const result = adapter._resolveChangePosition(change, currentDoc)

    expect(result.success).toBe(true)
    expect(result.method).toBe('replaceAll_redo')
    expect(result.resolvedChange.newContent).toBe('bar and bar again')
  })

  it('returns NOT_FOUND for replaceAll when target gone', () => {
    const change = {
      oldText: 'foo',
      newText: 'bar',
      position: null,
      replaceAll: true,
      baseVersion: 5,
    }
    const currentDoc = { content: 'no match here', version: 8 }

    const result = adapter._resolveChangePosition(change, currentDoc)

    expect(result.success).toBe(false)
    expect(result.conflictType).toBe('NOT_FOUND')
  })
})

describe('DocumentAdapter._disambiguateByPosition', () => {
  let adapter

  beforeEach(() => {
    adapter = new DocumentAdapter()
  })

  it('disambiguates by closest position when confident', () => {
    // "abc" appears at positions 0 and 100, original position was 0
    const change = {
      oldText: 'abc',
      position: { start: 0, end: 3 },
      baseVersion: 5,
    }
    const content = 'abc' + 'x'.repeat(97) + 'abc'

    const result = adapter._disambiguateByPosition(change, content, 8)

    expect(result.success).toBe(true)
    expect(result.method).toBe('position_disambiguated')
    expect(result.resolvedChange.position.start).toBe(0)
  })

  it('returns AMBIGUOUS_CLOSE when two matches are too close together', () => {
    // "abc" appears at positions 5 and 15, original position was 10
    const change = {
      oldText: 'abc',
      position: { start: 10, end: 13 },
      baseVersion: 5,
    }
    const content = 'xxxxx' + 'abc' + 'xxxxxxx' + 'abc'

    const result = adapter._disambiguateByPosition(change, content, 8)

    expect(result.success).toBe(false)
    expect(result.conflictType).toBe('AMBIGUOUS_CLOSE')
  })

  it('returns AMBIGUOUS_FAR when closest match exceeds MAX_SHIFT', () => {
    // "abc" appears very far from original position
    const change = {
      oldText: 'abc',
      position: { start: 0, end: 3 },
      baseVersion: 5,
    }
    const content = 'x'.repeat(600) + 'abc' + 'x'.repeat(100) + 'abc'

    const result = adapter._disambiguateByPosition(change, content, 8)

    expect(result.success).toBe(false)
    expect(result.conflictType).toBe('AMBIGUOUS_FAR')
  })
})

describe('DocumentAdapter._applyChangeToContent', () => {
  let adapter

  beforeEach(() => {
    adapter = new DocumentAdapter()
  })

  it('applies replacement correctly', () => {
    const content = 'Hello World'
    const change = {
      position: { start: 6, end: 11 },
      oldText: 'World',
      newText: 'Earth',
    }

    const result = adapter._applyChangeToContent(content, change)
    expect(result).toBe('Hello Earth')
  })

  it('applies deletion correctly', () => {
    const content = 'Hello World'
    const change = {
      position: { start: 5, end: 11 },
      oldText: ' World',
      newText: '',
    }

    const result = adapter._applyChangeToContent(content, change)
    expect(result).toBe('Hello')
  })

  it('applies insertion correctly', () => {
    const content = 'Hello'
    const change = {
      position: { start: 5, end: 5 },
      oldText: '',
      newText: ' World',
    }

    const result = adapter._applyChangeToContent(content, change)
    expect(result).toBe('Hello World')
  })
})

describe('DocumentAdapter.previewEdit with replacer chain', () => {
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

  function mockDocument(content, version = 5) {
    const lines = content.split('\n')
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        lines,
        version,
        ranges: {},
      })
    )
  }

  it('matches exact text (SimpleReplacer)', async () => {
    mockDocument('hello unique world')

    const result = await adapter.previewEdit(
      'proj-1',
      'doc-1',
      'hello unique world',
      'goodbye'
    )

    expect(result.oldText).toBe('hello unique world')
    expect(result.position.start).toBe(0)
  })

  it('throws when oldText matches multiple times', async () => {
    mockDocument('hello world hello world')

    try {
      await adapter.previewEdit('proj-1', 'doc-1', 'hello world', 'goodbye')
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error.name).toBe('EditMatchError')
    }
  })

  it('throws when oldText is not found', async () => {
    mockDocument('hello world')

    try {
      await adapter.previewEdit('proj-1', 'doc-1', 'nonexistent text', 'goodbye')
      expect.fail('Should have thrown')
    } catch (error) {
      expect(error.name).toBe('EditMatchError')
    }
  })

  it('matches with line-trimmed whitespace (LineTrimmedReplacer)', async () => {
    mockDocument('  hello world  \n  foo bar  ')

    const result = await adapter.previewEdit(
      'proj-1',
      'doc-1',
      'hello world\nfoo bar',
      'replacement'
    )

    // Should match the actual content with original whitespace
    expect(result.oldText).toBe('  hello world  \n  foo bar  ')
    expect(result.position.start).toBe(0)
  })

  it('matches with flexible indentation (IndentationFlexibleReplacer)', async () => {
    mockDocument('    line one\n    line two\n    line three')

    const result = await adapter.previewEdit(
      'proj-1',
      'doc-1',
      '  line one\n  line two\n  line three',
      'replacement'
    )

    expect(result.oldText).toBe('    line one\n    line two\n    line three')
  })

  it('returns matchedText which may differ from input oldText', async () => {
    mockDocument('  indented line\n  another line')

    const result = await adapter.previewEdit(
      'proj-1',
      'doc-1',
      'indented line\nanother line',
      'replacement'
    )

    // matchedText should be the actual content text (with original indentation)
    expect(result.oldText).toBe('  indented line\n  another line')
  })
})
