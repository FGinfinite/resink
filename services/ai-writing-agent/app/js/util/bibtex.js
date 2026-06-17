const MONTH_MAP = {
  january: 'jan', february: 'feb', march: 'mar', april: 'apr',
  may: 'may', june: 'jun', july: 'jul', august: 'aug',
  september: 'sep', october: 'oct', november: 'nov', december: 'dec',
}

const FIELD_ORDER = [
  'author', 'title', 'year', 'journal', 'booktitle',
  'volume', 'number', 'pages', 'doi', 'url', 'abstract',
]

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'and', 'or', 'to', 'with', 'by', 'from', 'is', 'at',
])

/**
 * Build an index of line start offsets for O(log n) line number lookups.
 * @param {string} content
 * @returns {number[]}
 */
function buildLineIndex(content) {
  const lineStarts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineStarts.push(i + 1)
    }
  }
  return lineStarts
}

/**
 * Get the 1-based line number for a character offset using binary search.
 * @param {number[]} lineStarts
 * @param {number} offset
 * @returns {number}
 */
function lineAtOffset(lineStarts, offset) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * Parse a BibTeX file content into structured entries.
 * @param {string} content - Raw BibTeX file content
 * @returns {Array<{key: string, type: string, fields: Object, raw: string, startLine: number, endLine: number}>}
 */
export function parseBibFile(content) {
  const entries = []
  const entryStartRe = /@(\w+)\s*[{(]([^,\s]+)\s*,/g
  const lineIndex = buildLineIndex(content)

  let match
  while ((match = entryStartRe.exec(content)) !== null) {
    const type = match[1].toLowerCase()
    // Skip special BibTeX entries that don't represent citable references
    if (type === 'string' || type === 'preamble' || type === 'comment') continue
    const key = match[2]
    const startOffset = match.index

    // Determine the delimiter pair used: { } or ( )
    const openDelim = content[match.index + match[0].indexOf(match[2]) - 1] === '(' ? '(' : '{'
    const closeDelim = openDelim === '(' ? ')' : '}'

    // Use delimiter counting to find the end of the entry
    let delimDepth = 0
    let entryEnd = -1
    const searchStart = content.indexOf(openDelim, startOffset)
    for (let i = searchStart; i < content.length; i++) {
      if (content[i] === openDelim) delimDepth++
      else if (content[i] === closeDelim) delimDepth--
      if (delimDepth === 0) {
        entryEnd = i + 1
        break
      }
    }
    if (entryEnd === -1) continue

    const raw = content.substring(startOffset, entryEnd)
    const startLine = lineAtOffset(lineIndex, startOffset)
    const endLine = lineAtOffset(lineIndex, entryEnd - 1)

    // Parse fields from the entry body (after "key,")
    const bodyStart = content.indexOf(',', searchStart) + 1
    const bodyEnd = entryEnd - 1
    const body = content.substring(bodyStart, bodyEnd)
    const fields = parseFields(body)

    entries.push({ key, type, fields, raw, startLine, endLine })
  }

  return entries
}

/**
 * Parse field = {value} or field = "value" pairs from entry body.
 * Advances past extracted values to avoid false matches on '=' inside values.
 * @param {string} body
 * @returns {Object}
 */
function parseFields(body) {
  const fields = {}
  const fieldRe = /(\w+)\s*=\s*/g

  let match
  while ((match = fieldRe.exec(body)) !== null) {
    const fieldName = match[1].toLowerCase()
    const valueStart = match.index + match[0].length
    const { value, endPos } = extractFieldValue(body, valueStart)
    if (value !== null) {
      fields[fieldName] = value
      // Advance past the extracted value to avoid matching '=' inside values
      fieldRe.lastIndex = endPos
    }
  }

  return fields
}

/**
 * Extract a field value starting at the given position.
 * Handles {braced}, "quoted", and bare values.
 * Returns both the value and the end position for cursor advancement.
 * @param {string} body
 * @param {number} start
 * @returns {{value: string|null, endPos: number}}
 */
function extractFieldValue(body, start) {
  let i = start
  // Skip whitespace
  while (i < body.length && /\s/.test(body[i])) i++

  if (i >= body.length) return { value: null, endPos: i }

  if (body[i] === '{') {
    // Brace-delimited value
    let depth = 0
    const valStart = i + 1
    for (; i < body.length; i++) {
      if (body[i] === '{') depth++
      else if (body[i] === '}') depth--
      if (depth === 0) return { value: body.substring(valStart, i), endPos: i + 1 }
    }
    return { value: null, endPos: i }
  }

  if (body[i] === '"') {
    // Quote-delimited value
    const valStart = i + 1
    for (i = valStart; i < body.length; i++) {
      if (body[i] === '"' && body[i - 1] !== '\\') {
        return { value: body.substring(valStart, i), endPos: i + 1 }
      }
    }
    return { value: null, endPos: i }
  }

  // Bare value (number or month macro)
  const bareMatch = body.substring(i).match(/^([^\s,}]+)/)
  if (bareMatch) {
    return { value: bareMatch[1], endPos: i + bareMatch[1].length }
  }
  return { value: null, endPos: i }
}

/**
 * Format a BibEntry back to standard BibTeX string.
 * @param {{key: string, type: string, fields: Object}} entry
 * @returns {string}
 */
export function formatBibEntry(entry) {
  const { key, type, fields } = entry

  // Order fields: standard order first, then remaining alphabetically
  const orderedKeys = []
  for (const f of FIELD_ORDER) {
    if (fields[f] != null) orderedKeys.push(f)
  }
  for (const f of Object.keys(fields).sort()) {
    if (!orderedKeys.includes(f)) orderedKeys.push(f)
  }

  const fieldLines = orderedKeys.map(f => `  ${f} = {${fields[f]}}`)
  return `@${type}{${key},\n${fieldLines.join(',\n')}\n}`
}

/**
 * Generate a citation key from metadata.
 * @param {{author?: string, authors?: string[], title?: string, year?: string|number}} metadata
 * @param {'authorYear'|'titleYear'} [style='authorYear']
 * @returns {string}
 */
export function generateBibKey(metadata, style = 'authorYear') {
  const year = metadata.year ? String(metadata.year) : ''

  if (style === 'authorYear') {
    const lastName = extractFirstAuthorLastName(metadata)
    return (lastName || 'Unknown') + year
  }

  if (style === 'titleYear') {
    const title = metadata.title || ''
    const words = title.split(/\s+/)
    const significant = words.find(w => !STOP_WORDS.has(w.toLowerCase()))
    const word = significant ? significant.replace(/[^a-zA-Z0-9]/g, '') : 'Untitled'
    return word + year
  }

  return 'Unknown' + year
}

/**
 * Extract the last name of the first author.
 * Handles "Last, First" and "First Last" formats, as well as authors array.
 * @param {{author?: string, authors?: string[]}} metadata
 * @returns {string}
 */
function extractFirstAuthorLastName(metadata) {
  let authorStr = ''
  if (metadata.authors && metadata.authors.length > 0) {
    authorStr = metadata.authors[0]
  } else if (metadata.author) {
    // Split by " and " to get first author
    authorStr = metadata.author.split(/\s+and\s+/i)[0].trim()
  }
  if (!authorStr) return ''

  // "Last, First" format
  if (authorStr.includes(',')) {
    return authorStr.split(',')[0].trim().replace(/[^a-zA-Z]/g, '')
  }

  // "First Last" format — take last word
  const parts = authorStr.trim().split(/\s+/)
  return parts[parts.length - 1].replace(/[^a-zA-Z]/g, '')
}

/**
 * Normalize a BibEntry: unify month abbreviations, clean DOI prefix, trim whitespace.
 * @param {{key: string, type: string, fields: Object}} entry
 * @returns {{key: string, type: string, fields: Object}}
 */
export function normalizeBibEntry(entry) {
  const fields = {}
  for (const [k, v] of Object.entries(entry.fields)) {
    let val = typeof v === 'string' ? v.trim() : v
    // Normalize month
    if (k === 'month' && typeof val === 'string') {
      const lower = val.toLowerCase()
      val = MONTH_MAP[lower] || val
    }
    // Clean DOI prefix
    if (k === 'doi' && typeof val === 'string') {
      val = val.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    }
    fields[k] = val
  }
  return { ...entry, fields }
}

/**
 * Normalize a DOI string for comparison: lowercase, strip URL prefix.
 * @param {string} doi
 * @returns {string}
 */
function normalizeDoi(doi) {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
}

/**
 * Find duplicate entries by DOI exact match or title+year fuzzy match.
 * @param {Array<{key: string, type: string, fields: Object}>} entries
 * @returns {Array<{entries: Array, reason: 'doi'|'title_year'}>}
 */
export function findDuplicates(entries) {
  const groups = []
  const seen = new Set()

  // DOI exact match (with normalization)
  const doiMap = new Map()
  for (const entry of entries) {
    const doi = entry.fields.doi
    if (!doi) continue
    const normalized = normalizeDoi(doi)
    if (!normalized) continue
    if (!doiMap.has(normalized)) doiMap.set(normalized, [])
    doiMap.get(normalized).push(entry)
  }
  for (const [, group] of doiMap) {
    if (group.length > 1) {
      groups.push({ entries: group, reason: 'doi' })
      for (const e of group) seen.add(e.key)
    }
  }

  // Title+year fuzzy match
  const titleYearMap = new Map()
  for (const entry of entries) {
    if (seen.has(entry.key)) continue
    const title = entry.fields.title
    const year = entry.fields.year
    if (!title || !year) continue
    const normalized = normalizeForComparison(title) + '|' + String(year).trim()
    if (!titleYearMap.has(normalized)) titleYearMap.set(normalized, [])
    titleYearMap.get(normalized).push(entry)
  }
  for (const [, group] of titleYearMap) {
    if (group.length > 1) {
      groups.push({ entries: group, reason: 'title_year' })
    }
  }

  return groups
}

/**
 * Normalize a string for fuzzy comparison: lowercase, strip punctuation.
 * @param {string} str
 * @returns {string}
 */
function normalizeForComparison(str) {
  return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Sort entries by the given order.
 * @param {Array<{key: string, type: string, fields: Object}>} entries
 * @param {'key'|'year'|'author'} [order='key']
 * @returns {Array}
 */
export function sortEntries(entries, order = 'key') {
  const sorted = [...entries]

  if (order === 'key') {
    sorted.sort((a, b) => a.key.localeCompare(b.key))
  } else if (order === 'year') {
    sorted.sort((a, b) => {
      const ya = parseInt(a.fields.year, 10) || 0
      const yb = parseInt(b.fields.year, 10) || 0
      return ya - yb
    })
  } else if (order === 'author') {
    sorted.sort((a, b) => {
      const aa = (a.fields.author || '').toLowerCase()
      const ab = (b.fields.author || '').toLowerCase()
      return aa.localeCompare(ab)
    })
  }

  return sorted
}

/**
 * Convert API-returned paper metadata to a BibTeX string.
 * @param {{title?: string, authors?: string[], author?: string, year?: number|string, doi?: string, venue?: string, journal?: string, booktitle?: string, volume?: string, number?: string, pages?: string, url?: string, abstract?: string}} metadata
 * @returns {string}
 */
export function formatBibTeX(metadata) {
  const key = metadata._overrideKey || generateBibKey(metadata)

  // Determine entry type
  const isConference = metadata.booktitle || (metadata.venue && !metadata.journal)
  const type = isConference ? 'inproceedings' : 'article'

  const fields = {}

  // Author
  if (metadata.authors && metadata.authors.length > 0) {
    fields.author = metadata.authors.join(' and ')
  } else if (metadata.author) {
    fields.author = metadata.author
  }

  if (metadata.title) fields.title = metadata.title
  if (metadata.year) fields.year = String(metadata.year)

  if (type === 'inproceedings') {
    fields.booktitle = metadata.booktitle || metadata.venue || ''
  } else {
    if (metadata.journal || metadata.venue) {
      fields.journal = metadata.journal || metadata.venue
    }
  }

  if (metadata.volume) fields.volume = String(metadata.volume)
  if (metadata.number) fields.number = String(metadata.number)
  if (metadata.pages) fields.pages = String(metadata.pages)
  if (metadata.doi) fields.doi = String(metadata.doi)
  if (metadata.url) fields.url = String(metadata.url)
  if (metadata.abstract) fields.abstract = String(metadata.abstract)

  return formatBibEntry({ key, type, fields })
}
