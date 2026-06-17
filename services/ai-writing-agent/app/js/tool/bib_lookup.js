import { z } from 'zod'
import { Tool, ToolResult } from './Tool.js'
import settings from '@overleaf/settings'
import { formatBibTeX, generateBibKey } from '../util/bibtex.js'

const DOI_RE = /^10\.\d{4,}\/\S+$/

/**
 * Normalize a query that may be a DOI in various formats:
 * - "10.1234/abc" (bare DOI)
 * - "https://doi.org/10.1234/abc" (URL)
 * - "http://dx.doi.org/10.1234/abc" (old URL)
 * - "doi:10.1234/abc" (doi: prefix)
 * Returns the bare DOI or the original query if not a DOI.
 * @param {string} query
 * @returns {{ normalized: string, isDoi: boolean }}
 */
function normalizeDoiQuery(query) {
  let q = query.trim()
  // Strip URL prefixes
  q = q.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
  // Strip doi: prefix
  q = q.replace(/^doi:/i, '')
  const isDoi = DOI_RE.test(q)
  return { normalized: isDoi ? q : query.trim(), isDoi }
}

const bibLookupSchema = z.object({
  query: z.string().describe('Search query: title, author, keywords, or DOI'),
  source: z.enum(['crossref', 'semanticscholar', 'arxiv', 'auto']).optional().default('auto')
    .describe('Which academic API to search. "auto" detects DOI and picks the best source.'),
  limit: z.number().int().min(1).max(settings.externalApis?.bibLookup?.maxLimit || 20).optional().default(settings.externalApis?.bibLookup?.defaultLimit || 5)
    .describe('Maximum number of results to return (1-20)'),
  format: z.enum(['bibtex', 'summary']).optional().default('summary')
    .describe('Output format: summary list or full BibTeX entries'),
})

/**
 * Decode common XML/HTML entities in a string.
 * @param {string} str
 * @returns {string}
 */
function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function truncateField(str, max) {
  if (!str || str.length <= max) return str || ''
  return str.slice(0, max) + '…'
}

const FIELD_LIMITS = {
  title: settings.externalApis?.bibLookup?.maxTitleLength || 300,
  author: settings.externalApis?.bibLookup?.maxAuthorLength || 100,
  abstract: settings.externalApis?.bibLookup?.maxAbstractLength || 1500,
  venue: settings.externalApis?.bibLookup?.maxVenueLength || 200,
}

/**
 * Tool for looking up academic papers from external APIs
 * (Semantic Scholar, CrossRef, arXiv) and returning citation metadata.
 */
export class BibLookupTool extends Tool {
  constructor() {
    super({
      name: 'bib_lookup',
      description: `Search academic databases for papers and retrieve citation metadata.
Sources: Semantic Scholar, CrossRef, arXiv.
Supports searching by title, author, keywords, or DOI.
Returns paper summaries or ready-to-use BibTeX entries.
Use "auto" source to let the tool pick the best API automatically.`,
      parameters: bibLookupSchema,
    })
  }

  /**
   * Get API configuration for a given source.
   * @param {string} source - API source name (e.g. 'semanticScholar', 'crossref', 'arxiv')
   * @returns {object}
   */
  _getApiConfig(source) {
    return settings.externalApis?.[source] || {}
  }

  /**
   * Execute the bib_lookup tool.
   * @param {object} args - Validated arguments
   * @param {object} _context - Execution context (unused)
   * @returns {Promise<ToolResult>}
   */
  async execute(args, _context) {
    const { query, source, limit, format } = args
    const { normalized: normalizedQuery, isDoi } = normalizeDoiQuery(query)

    try {
      let papers = []

      if (source === 'auto') {
        papers = await this._autoLookup(normalizedQuery, limit, isDoi)
      } else if (source === 'semanticscholar') {
        papers = isDoi
          ? await this._semanticScholarDoiLookup(normalizedQuery)
          : await this._semanticScholarSearch(normalizedQuery, limit)
      } else if (source === 'crossref') {
        papers = isDoi
          ? await this._crossrefDoiLookup(normalizedQuery)
          : await this._crossrefSearch(normalizedQuery, limit)
      } else if (source === 'arxiv') {
        papers = await this._arxivSearch(normalizedQuery, limit)
      }

      if (papers.length === 0) {
        return ToolResult.success(
          `No results found for query "${query}" (source: ${source}).`,
          { resultCount: 0 }
        )
      }

      const output = this._formatResults(papers, format, query, source)
      return ToolResult.success(output, { resultCount: papers.length })
    } catch (err) {
      return ToolResult.error(`bib_lookup failed: ${err.message}`)
    }
  }

  /**
   * Auto mode: detect DOI or search, with fallback from Semantic Scholar to CrossRef.
   */
  async _autoLookup(query, limit, isDoi) {
    if (isDoi) {
      // DOI direct lookup via Semantic Scholar
      try {
        const papers = await this._semanticScholarDoiLookup(query)
        if (papers.length > 0) return papers
      } catch {
        // fall through to CrossRef
      }
      return this._crossrefDoiLookup(query)
    }

    // General search: try Semantic Scholar first, fallback to CrossRef
    try {
      const papers = await this._semanticScholarSearch(query, limit)
      if (papers.length > 0) return papers
    } catch {
      // fall through
    }
    return this._crossrefSearch(query, limit)
  }

  // ---------------------------------------------------------------------------
  // Semantic Scholar
  // ---------------------------------------------------------------------------

  async _semanticScholarSearch(query, limit) {
    const cfg = this._getApiConfig('semanticScholar')
    const baseUrl = cfg.baseUrl || 'https://api.semanticscholar.org/graph/v1'
    const fields = 'title,authors,year,abstract,citationCount,externalIds,venue'
    const url = `${baseUrl}/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${fields}`

    const data = await this._fetchJson(url, this._semanticScholarHeaders())
    if (!data || !data.data || data.data.length === 0) return []

    return data.data.map(p => this._normalizeSemanticScholar(p))
  }

  async _semanticScholarDoiLookup(doi) {
    const cfg = this._getApiConfig('semanticScholar')
    const baseUrl = cfg.baseUrl || 'https://api.semanticscholar.org/graph/v1'
    const fields = 'title,authors,year,abstract,citationCount,externalIds,venue'
    const url = `${baseUrl}/paper/DOI:${encodeURIComponent(doi)}?fields=${fields}`

    let data
    try {
      data = await this._fetchJson(url, this._semanticScholarHeaders())
    } catch (err) {
      // DOI not found — treat as empty result, not an error
      if (err.status === 404 || err.status === 410) return []
      throw err
    }
    if (!data || !data.title) return []

    return [this._normalizeSemanticScholar(data)]
  }

  _semanticScholarHeaders() {
    const cfg = this._getApiConfig('semanticScholar')
    const headers = {}
    if (cfg.apiKey) {
      headers['x-api-key'] = cfg.apiKey
    }
    return headers
  }

  _normalizeSemanticScholar(paper) {
    const doi = paper.externalIds?.DOI || ''
    const arxivId = paper.externalIds?.ArXiv || ''
    return {
      title: truncateField(paper.title, FIELD_LIMITS.title),
      authors: (paper.authors || []).map(a => truncateField(a.name, FIELD_LIMITS.author)),
      year: paper.year || '',
      venue: truncateField(paper.venue, FIELD_LIMITS.venue),
      citationCount: paper.citationCount ?? null,
      doi,
      abstract: truncateField(paper.abstract, FIELD_LIMITS.abstract),
      url: doi ? `https://doi.org/${doi}` : (arxivId ? `https://arxiv.org/abs/${arxivId}` : ''),
      source: 'semanticscholar',
    }
  }

  // ---------------------------------------------------------------------------
  // CrossRef
  // ---------------------------------------------------------------------------

  async _crossrefSearch(query, limit) {
    const cfg = this._getApiConfig('crossref')
    const baseUrl = cfg.baseUrl || 'https://api.crossref.org'
    const url = `${baseUrl}/works?query=${encodeURIComponent(query)}&rows=${limit}`

    const data = await this._fetchJson(url, this._crossrefHeaders())
    if (!data || !data.message || !data.message.items || data.message.items.length === 0) return []

    return data.message.items.map(item => this._normalizeCrossref(item))
  }

  async _crossrefDoiLookup(doi) {
    const cfg = this._getApiConfig('crossref')
    const baseUrl = cfg.baseUrl || 'https://api.crossref.org'
    const url = `${baseUrl}/works/${encodeURIComponent(doi)}`

    let data
    try {
      data = await this._fetchJson(url, this._crossrefHeaders())
    } catch (err) {
      // DOI not found — treat as empty result, not an error
      if (err.status === 404 || err.status === 410) return []
      throw err
    }
    if (!data || !data.message) return []

    return [this._normalizeCrossref(data.message)]
  }

  _crossrefHeaders() {
    const cfg = this._getApiConfig('crossref')
    const headers = {}
    if (cfg.email) {
      headers['User-Agent'] = `ResInkAI/1.0 (mailto:${cfg.email})`
    }
    return headers
  }

  _normalizeCrossref(item) {
    const authors = (item.author || []).map(a => {
      if (a.given && a.family) return `${a.given} ${a.family}`
      return a.name || a.family || ''
    }).filter(Boolean)

    const doi = item.DOI || ''
    const year = item.published?.['date-parts']?.[0]?.[0]
      || item['published-print']?.['date-parts']?.[0]?.[0]
      || item.created?.['date-parts']?.[0]?.[0]
      || ''

    const venue = (item['container-title'] && item['container-title'][0]) || ''

    return {
      title: truncateField(Array.isArray(item.title) ? item.title[0] || '' : item.title || '', FIELD_LIMITS.title),
      authors: authors.map(a => truncateField(a, FIELD_LIMITS.author)),
      year,
      venue: truncateField(venue, FIELD_LIMITS.venue),
      citationCount: item['is-referenced-by-count'] ?? null,
      doi,
      abstract: truncateField(item.abstract, FIELD_LIMITS.abstract),
      url: doi ? `https://doi.org/${doi}` : '',
      source: 'crossref',
    }
  }

  // ---------------------------------------------------------------------------
  // arXiv
  // ---------------------------------------------------------------------------

  async _arxivSearch(query, limit) {
    const cfg = this._getApiConfig('arxiv')
    const baseUrl = cfg.baseUrl || 'https://export.arxiv.org/api'
    const url = `${baseUrl}/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`

    const text = await this._fetchText(url)
    if (!text) return []

    return this._parseArxivXml(text)
  }

  /**
   * Parse arXiv Atom XML response with regex for the basic fields we need.
   */
  _parseArxivXml(xml) {
    const papers = []
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g

    let match
    while ((match = entryRe.exec(xml)) !== null) {
      const entry = match[1]

      const title = decodeXmlEntities((entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').replace(/\s+/g, ' ').trim())
      const summary = decodeXmlEntities((entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').replace(/\s+/g, ' ').trim())
      const published = entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] || ''
      const year = published ? new Date(published).getFullYear() : ''
      const arxivUrl = entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || ''

      // Extract authors
      const authors = []
      const authorRe = /<author>\s*<name>([\s\S]*?)<\/name>/g
      let authorMatch
      while ((authorMatch = authorRe.exec(entry)) !== null) {
        authors.push(decodeXmlEntities(authorMatch[1].trim()))
      }

      // Extract DOI if present
      const doi = entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/)?.[1]?.trim() || ''

      // Extract arXiv ID from URL
      const arxivId = arxivUrl.match(/abs\/(.+)/)?.[1] || ''

      papers.push({
        title: truncateField(title, FIELD_LIMITS.title),
        authors: authors.map(a => truncateField(a, FIELD_LIMITS.author)),
        year,
        venue: 'arXiv',
        citationCount: null,
        doi,
        abstract: truncateField(summary, FIELD_LIMITS.abstract),
        url: arxivUrl,
        arxivId,
        source: 'arxiv',
      })
    }

    return papers
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch JSON from a URL with timeout and retry on 429.
   * @param {string} url
   * @param {object} [extraHeaders={}]
   * @returns {Promise<object|null>}
   */
  async _fetchJson(url, extraHeaders = {}) {
    const text = await this._fetchText(url, extraHeaders, 'application/json')
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error('Failed to parse academic API response')
    }
  }

  /**
   * Fetch text from a URL with timeout and retry on 429.
   * @param {string} url
   * @param {object} [extraHeaders={}]
   * @param {string} [accept]
   * @returns {Promise<string|null>}
   */
  async _fetchText(url, extraHeaders = {}, accept) {
    return this._fetchWithRetry(url, {
      headers: {
        ...(accept ? { Accept: accept } : {}),
        ...extraHeaders,
      },
    })
  }

  /**
   * Fetch with retry on HTTP 429 (rate limit) and server errors using exponential backoff.
   * Does not retry 4xx client errors (except 429).
   * @param {string} url
   * @param {object} options - fetch options
   * @returns {Promise<string|null>}
   */
  async _fetchWithRetry(url, options = {}) {
    const timeout = settings.externalApis?.timeout || 15000
    const maxRetries = settings.externalApis?.maxRetries || 3

    let lastError = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(timeout),
        })

        if (response.status === 429 && attempt < maxRetries) {
          // Consume the response body to prevent connection leak
          await response.text()
          // Read Retry-After header if available
          const retryAfterHeader = parseInt(response.headers.get('Retry-After'), 10)
          const retryAfterMs = (!isNaN(retryAfterHeader) && retryAfterHeader > 0)
            ? Math.min(retryAfterHeader, settings.externalApis?.retryAfterCapSeconds || 30) * 1000
            : Math.pow(2, attempt) * 1000
          await new Promise(resolve => setTimeout(resolve, retryAfterMs))
          continue
        }

        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}: ${response.statusText}`)
          err.status = response.status
          // Consume body to prevent connection leak
          await response.text()
          throw err
        }

        // Read response body with size limit to prevent memory exhaustion
        const maxResponseBytes = settings.externalApis?.maxResponseBytes || 5 * 1024 * 1024 // 5MB
        const reader = response.body.getReader()
        const chunks = []
        let totalBytes = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          totalBytes += value.length
          if (totalBytes > maxResponseBytes) {
            reader.cancel()
            throw new Error(`Response body exceeds ${maxResponseBytes} bytes limit`)
          }
          chunks.push(value)
        }
        const decoder = new TextDecoder()
        return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode()
      } catch (err) {
        lastError = err

        // Do not retry non-retryable 4xx errors (except 429 handled above)
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          break
        }

        // Retry on timeout, 5xx, 429, or network errors
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000
          await new Promise(resolve => setTimeout(resolve, delay))
          continue
        }
      }
    }

    throw lastError || new Error(`Academic API lookup failed after ${maxRetries + 1} attempts`)
  }

  // ---------------------------------------------------------------------------
  // Output formatting
  // ---------------------------------------------------------------------------

  /**
   * Format results as a numbered summary or summary + BibTeX.
   * @param {Array} papers
   * @param {string} format - 'summary' or 'bibtex'
   * @param {string} query
   * @param {string} source
   * @returns {string}
   */
  _formatResults(papers, format, query, source) {
    const lines = [`Search results for "${query}" (source: ${source}, ${papers.length} result(s)):`, '']

    // Track used BibTeX keys to avoid duplicates
    const usedKeys = new Set()

    for (let i = 0; i < papers.length; i++) {
      const p = papers[i]
      const authorStr = p.authors.length > 0
        ? p.authors.length <= 3
          ? p.authors.join(', ')
          : `${p.authors[0]} et al.`
        : 'Unknown'

      lines.push(`${i + 1}. ${p.title}`)
      lines.push(`   Authors: ${authorStr}`)
      lines.push(`   Year: ${p.year || 'N/A'}`)
      if (p.venue) lines.push(`   Venue: ${p.venue}`)
      if (p.citationCount != null) lines.push(`   Citations: ${p.citationCount}`)
      if (p.doi) lines.push(`   DOI: ${p.doi}`)

      if (format === 'bibtex') {
        // Generate a unique key for this paper
        const metadata = {
          title: p.title,
          authors: p.authors,
          year: p.year,
          doi: p.doi,
          venue: p.venue,
          url: p.url,
          abstract: p.abstract,
        }
        let key = generateBibKey(metadata)
        if (usedKeys.has(key)) {
          let suffix = 'a'
          while (usedKeys.has(key + suffix)) {
            suffix = String.fromCharCode(suffix.charCodeAt(0) + 1)
          }
          key = key + suffix
        }
        usedKeys.add(key)

        const bibtex = formatBibTeX({ ...metadata, _overrideKey: key })
        lines.push('')
        lines.push('   ```bibtex')
        for (const bibLine of bibtex.split('\n')) {
          lines.push(`   ${bibLine}`)
        }
        lines.push('   ```')
      }

      lines.push('')
    }

    return lines.join('\n')
  }
}

export function createBibLookupTool() {
  return new BibLookupTool()
}

export default BibLookupTool
