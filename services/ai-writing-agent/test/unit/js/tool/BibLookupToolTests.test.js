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
    externalApis: {
      semanticScholar: { baseUrl: 'https://api.semanticscholar.org/graph/v1', apiKey: '' },
      crossref: { baseUrl: 'https://api.crossref.org', email: '' },
      arxiv: { baseUrl: 'http://export.arxiv.org/api' },
      timeout: 10000,
      maxRetries: 2,
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

// Mock the bibtex utility used by formatBibTeX
vi.mock('../../../../app/js/util/bibtex.js', () => ({
  formatBibTeX: vi.fn((metadata) => {
    const key = metadata._overrideKey || (metadata.authors?.[0]?.split(' ').pop() || 'Unknown') + (metadata.year || '')
    return `@article{${key},\n  title = {${metadata.title || ''}}\n}`
  }),
  generateBibKey: vi.fn((metadata) => {
    return (metadata.authors?.[0]?.split(' ').pop() || 'Unknown') + (metadata.year || '')
  }),
}))

const mockFetch = vi.fn()
global.fetch = mockFetch

const { BibLookupTool } = await import(
  '../../../../app/js/tool/bib_lookup.js'
)

function mockApiResponse(body, options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText || 'OK',
    headers: {
      get: vi.fn(name => options.headers?.[name] || null),
    },
    text: vi.fn(async () => text),
    body: ReadableStream.from([new TextEncoder().encode(text)]),
  }
}

describe('BibLookupTool', () => {
  let tool
  let mockContext

  beforeEach(() => {
    tool = new BibLookupTool()
    mockFetch.mockReset()

    mockContext = {
      sessionId: 'session-1',
      projectId: 'proj-1',
      adapters: {},
    }
  })

  it('has correct name "bib_lookup"', () => {
    expect(tool.name).toBe('bib_lookup')
  })

  describe('execute', () => {
    it('returns results for successful Semantic Scholar search (auto mode)', async () => {
      const s2Response = {
        data: [
          {
            title: 'Attention Is All You Need',
            authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }],
            year: 2017,
            venue: 'NeurIPS',
            citationCount: 50000,
            abstract: 'The dominant sequence transduction models...',
            externalIds: { DOI: '10.5555/3295222.3295349' },
          },
        ],
      }

      mockFetch.mockResolvedValueOnce(mockApiResponse(s2Response))

      const result = await tool.execute(
        { query: 'attention is all you need', source: 'auto', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.resultCount).toBe(1)
      expect(result.output).toContain('Attention Is All You Need')
      expect(result.output).toContain('Ashish Vaswani')
      expect(result.output).toContain('2017')
    })

    it('detects DOI and performs direct lookup', async () => {
      const s2Response = {
        title: 'Some Paper',
        authors: [{ name: 'John Doe' }],
        year: 2020,
        venue: 'Nature',
        citationCount: 100,
        abstract: 'Abstract text',
        externalIds: { DOI: '10.1234/test.2020' },
      }

      mockFetch.mockResolvedValueOnce(mockApiResponse(s2Response))

      const result = await tool.execute(
        { query: '10.1234/test.2020', source: 'auto', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.resultCount).toBe(1)
      expect(result.output).toContain('Some Paper')
      // Should have called the DOI endpoint
      expect(mockFetch).toHaveBeenCalledTimes(1)
      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('/paper/DOI:')
    })

    it('falls back to CrossRef when Semantic Scholar returns empty', async () => {
      // Semantic Scholar returns empty
      mockFetch.mockResolvedValueOnce(mockApiResponse({ data: [] }))

      // CrossRef returns results
      const crossrefResponse = {
        message: {
          items: [
            {
              title: ['Fallback Paper'],
              author: [{ given: 'Jane', family: 'Smith' }],
              published: { 'date-parts': [[2021]] },
              'container-title': ['Journal of Testing'],
              DOI: '10.9999/fallback',
              'is-referenced-by-count': 42,
              abstract: 'A fallback result.',
            },
          ],
        },
      }

      mockFetch.mockResolvedValueOnce(mockApiResponse(crossrefResponse))

      const result = await tool.execute(
        { query: 'some obscure topic', source: 'auto', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.resultCount).toBe(1)
      expect(result.output).toContain('Fallback Paper')
      expect(result.output).toContain('Jane Smith')
    })

    it('retries on 429 rate limit', async () => {
      // First attempt: 429
      mockFetch.mockResolvedValueOnce(mockApiResponse('Rate limited', {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      }))

      // Second attempt: success
      const s2Response = {
        data: [
          {
            title: 'Retry Paper',
            authors: [{ name: 'Retry Author' }],
            year: 2023,
            venue: 'RetryConf',
            citationCount: 10,
            abstract: '',
            externalIds: {},
          },
        ],
      }
      mockFetch.mockResolvedValueOnce(mockApiResponse(s2Response))

      const result = await tool.execute(
        { query: 'retry test', source: 'semanticscholar', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.resultCount).toBe(1)
      expect(result.output).toContain('Retry Paper')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('handles timeout errors', async () => {
      const timeoutError = new Error('The operation was aborted due to timeout')
      timeoutError.name = 'TimeoutError'

      // All attempts fail with timeout
      mockFetch.mockRejectedValue(timeoutError)

      const result = await tool.execute(
        { query: 'timeout test', source: 'semanticscholar', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(false)
      expect(result.output).toContain('bib_lookup failed')
    })

    it('returns empty results message', async () => {
      mockFetch.mockResolvedValueOnce(mockApiResponse({ data: [] }))

      // CrossRef also empty (auto fallback)
      mockFetch.mockResolvedValueOnce(mockApiResponse({ message: { items: [] } }))

      const result = await tool.execute(
        { query: 'xyznonexistent12345', source: 'auto', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('No results found')
      expect(result.data.resultCount).toBe(0)
    })

    it('includes BibTeX code block for bibtex format', async () => {
      const s2Response = {
        data: [
          {
            title: 'BibTeX Test Paper',
            authors: [{ name: 'Alice Wonderland' }],
            year: 2022,
            venue: 'BibConf',
            citationCount: 5,
            abstract: 'Testing bibtex output',
            externalIds: { DOI: '10.1111/bib.test' },
          },
        ],
      }

      mockFetch.mockResolvedValueOnce(mockApiResponse(s2Response))

      const result = await tool.execute(
        { query: 'bibtex test', source: 'semanticscholar', limit: 5, format: 'bibtex' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('```bibtex')
      expect(result.output).toContain('@article{')
    })

    it('searches arXiv and parses XML results', async () => {
      const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed>
  <entry>
    <id>http://arxiv.org/abs/2301.00001v1</id>
    <title>An ArXiv Paper on Testing</title>
    <summary>This paper explores testing methodologies.</summary>
    <published>2023-01-15T00:00:00Z</published>
    <author><name>Bob Builder</name></author>
    <author><name>Carol Singer</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.5555/arxiv.test</arxiv:doi>
  </entry>
</feed>`

      mockFetch.mockResolvedValueOnce(mockApiResponse(arxivXml))

      const result = await tool.execute(
        { query: 'testing methodologies', source: 'arxiv', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.resultCount).toBe(1)
      expect(result.output).toContain('An ArXiv Paper on Testing')
      expect(result.output).toContain('Bob Builder')
      expect(result.output).toContain('2023')
      expect(result.output).toContain('arXiv')
    })

    it('retries on AbortError (timeout) then succeeds', async () => {
      const abortError = new Error('The operation was aborted')
      abortError.name = 'AbortError'

      // First attempt: AbortError, second attempt: success
      mockFetch
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce(mockApiResponse({
          data: [{
            title: 'After Retry',
            authors: [{ name: 'Retry Author' }],
            year: 2024,
            venue: 'RetryConf',
            citationCount: 1,
            externalIds: { DOI: '10.1234/retry' },
            abstract: '',
          }],
        }))

      const result = await tool.execute(
        { query: 'retry test', source: 'semanticscholar', limit: 1, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.output).toContain('After Retry')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('strips DOI URL prefix and performs direct lookup (Codex round 2)', async () => {
      const s2Response = {
        title: 'DOI URL Paper',
        authors: [{ name: 'URL Author' }],
        year: 2023,
        venue: 'URLConf',
        citationCount: 50,
        abstract: 'Testing DOI URL normalization',
        externalIds: { DOI: '10.1234/url.test' },
      }

      mockFetch.mockResolvedValueOnce(mockApiResponse(s2Response))

      const result = await tool.execute(
        { query: 'https://doi.org/10.1234/url.test', source: 'auto', limit: 5, format: 'summary' },
        mockContext
      )

      expect(result.success).toBe(true)
      expect(result.data.resultCount).toBe(1)
      // Should have called DOI endpoint, not search
      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('/paper/DOI:')
      // DOI may be URL-encoded (/ → %2F)
      expect(calledUrl).toMatch(/10\.1234/)
    })

    it('rejects limit values outside 1-20 range via schema', () => {
      const schema = tool.parameters
      expect(() => schema.parse({ query: 'test', limit: 0 })).toThrow()
      expect(() => schema.parse({ query: 'test', limit: 21 })).toThrow()
      expect(() => schema.parse({ query: 'test', limit: 1.5 })).toThrow()
      const valid = schema.parse({ query: 'test', limit: 10 })
      expect(valid.limit).toBe(10)
    })
  })
})
