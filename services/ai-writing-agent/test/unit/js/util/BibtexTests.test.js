import { describe, it, expect } from 'vitest'
import {
  parseBibFile,
  formatBibEntry,
  generateBibKey,
  normalizeBibEntry,
  findDuplicates,
  sortEntries,
  formatBibTeX,
} from '../../../../app/js/util/bibtex.js'

describe('bibtex.js', () => {
  describe('parseBibFile', () => {
    it('parses a standard article entry', () => {
      const bib = `@article{Smith2020,
  author = {John Smith},
  title = {A Great Paper},
  year = {2020},
  journal = {Nature}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].key).toBe('Smith2020')
      expect(entries[0].type).toBe('article')
      expect(entries[0].fields.author).toBe('John Smith')
      expect(entries[0].fields.title).toBe('A Great Paper')
      expect(entries[0].fields.year).toBe('2020')
      expect(entries[0].fields.journal).toBe('Nature')
    })

    it('handles nested braces in field values', () => {
      const bib = `@article{Key1,
  title = {A {LaTeX} Title with {Nested {Braces}}}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].fields.title).toBe('A {LaTeX} Title with {Nested {Braces}}')
    })

    it('skips malformed entries without closing brace', () => {
      const bib = `@article{Broken,
  title = {No closing brace`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(0)
    })

    it('parses multiple entries', () => {
      const bib = `@article{First2020,
  author = {Alice},
  year = {2020}
}

@inproceedings{Second2021,
  author = {Bob},
  year = {2021}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(2)
      expect(entries[0].key).toBe('First2020')
      expect(entries[0].type).toBe('article')
      expect(entries[1].key).toBe('Second2021')
      expect(entries[1].type).toBe('inproceedings')
    })

    it('parses entries with quoted values', () => {
      const bib = `@article{Quoted2020,
  author = "Jane Doe",
  title = "Quoted Title",
  year = {2020}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].fields.author).toBe('Jane Doe')
      expect(entries[0].fields.title).toBe('Quoted Title')
    })

    it('parses bare values (numbers and month macros)', () => {
      const bib = `@article{Bare2020,
  year = 2020,
  volume = 42
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].fields.year).toBe('2020')
      expect(entries[0].fields.volume).toBe('42')
    })

    it('reports correct startLine and endLine', () => {
      const bib = `% comment line
@article{Key1,
  title = {Title}
}
`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].startLine).toBe(2)
      expect(entries[0].endLine).toBe(4)
    })

    it('returns empty array for empty content', () => {
      expect(parseBibFile('')).toEqual([])
    })

    it('returns empty array for content without entries', () => {
      expect(parseBibFile('% just a comment\n% another comment')).toEqual([])
    })
  })

  describe('formatBibEntry', () => {
    it('formats an entry to standard BibTeX string', () => {
      const entry = {
        key: 'Smith2020',
        type: 'article',
        fields: {
          author: 'John Smith',
          title: 'A Paper',
          year: '2020',
        },
      }
      const result = formatBibEntry(entry)
      expect(result).toBe(
        '@article{Smith2020,\n' +
        '  author = {John Smith},\n' +
        '  title = {A Paper},\n' +
        '  year = {2020}\n' +
        '}'
      )
    })

    it('orders standard fields before non-standard fields', () => {
      const entry = {
        key: 'Test2020',
        type: 'article',
        fields: {
          note: 'A note',
          title: 'Title',
          author: 'Author',
          year: '2020',
          custom_field: 'custom',
        },
      }
      const result = formatBibEntry(entry)
      const lines = result.split('\n')
      // author should come before title, which should come before year
      const authorIdx = lines.findIndex(l => l.includes('author'))
      const titleIdx = lines.findIndex(l => l.includes('title'))
      const yearIdx = lines.findIndex(l => l.includes('year'))
      const noteIdx = lines.findIndex(l => l.includes('note'))
      const customIdx = lines.findIndex(l => l.includes('custom_field'))

      expect(authorIdx).toBeLessThan(titleIdx)
      expect(titleIdx).toBeLessThan(yearIdx)
      // Non-standard fields come after standard ones
      expect(yearIdx).toBeLessThan(customIdx)
      expect(yearIdx).toBeLessThan(noteIdx)
    })

    it('handles entry with no fields', () => {
      const entry = { key: 'Empty', type: 'misc', fields: {} }
      const result = formatBibEntry(entry)
      expect(result).toBe('@misc{Empty,\n\n}')
    })
  })

  describe('generateBibKey', () => {
    it('generates authorYear key from author string', () => {
      const key = generateBibKey({ author: 'John Smith', year: 2020 }, 'authorYear')
      expect(key).toBe('Smith2020')
    })

    it('generates authorYear key from authors array', () => {
      const key = generateBibKey({ authors: ['Jane Doe', 'Bob Jones'], year: 2021 }, 'authorYear')
      expect(key).toBe('Doe2021')
    })

    it('handles "Last, First" author format', () => {
      const key = generateBibKey({ author: 'Einstein, Albert', year: 1905 }, 'authorYear')
      expect(key).toBe('Einstein1905')
    })

    it('handles multiple authors with "and"', () => {
      const key = generateBibKey({ author: 'Alice Wang and Bob Smith', year: 2020 }, 'authorYear')
      expect(key).toBe('Wang2020')
    })

    it('returns "Unknown" prefix when no author', () => {
      const key = generateBibKey({ year: 2020 }, 'authorYear')
      expect(key).toBe('Unknown2020')
    })

    it('generates titleYear key', () => {
      const key = generateBibKey({ title: 'A Novel Approach to Deep Learning', year: 2021 }, 'titleYear')
      expect(key).toBe('Novel2021')
    })

    it('skips stop words in titleYear style', () => {
      const key = generateBibKey({ title: 'The Art of Programming', year: 2020 }, 'titleYear')
      expect(key).toBe('Art2020')
    })

    it('returns "Untitled" when title has only stop words', () => {
      const key = generateBibKey({ title: 'the of and', year: 2020 }, 'titleYear')
      expect(key).toBe('Untitled2020')
    })

    it('handles missing year', () => {
      const key = generateBibKey({ author: 'Smith' }, 'authorYear')
      expect(key).toBe('Smith')
    })

    it('handles missing fields entirely', () => {
      const key = generateBibKey({})
      expect(key).toBe('Unknown')
    })
  })

  describe('normalizeBibEntry', () => {
    it('normalizes full month name to abbreviation', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { month: 'January', year: '2020' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.month).toBe('jan')
    })

    it('normalizes month case-insensitively', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { month: 'FEBRUARY' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.month).toBe('feb')
    })

    it('keeps already-abbreviated months unchanged', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { month: 'mar' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.month).toBe('mar')
    })

    it('cleans DOI prefix https://doi.org/', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { doi: 'https://doi.org/10.1234/test' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.doi).toBe('10.1234/test')
    })

    it('cleans DOI prefix http://doi.org/', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { doi: 'http://doi.org/10.5678/abc' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.doi).toBe('10.5678/abc')
    })

    it('leaves bare DOI untouched', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { doi: '10.1234/already-bare' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.doi).toBe('10.1234/already-bare')
    })

    it('trims whitespace from all fields', () => {
      const entry = {
        key: 'Test', type: 'article',
        fields: { title: '  Spaced Title  ', author: '  Author  ' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.fields.title).toBe('Spaced Title')
      expect(result.fields.author).toBe('Author')
    })

    it('preserves key and type from original entry', () => {
      const entry = {
        key: 'Original', type: 'inproceedings',
        fields: { title: 'Title' },
      }
      const result = normalizeBibEntry(entry)
      expect(result.key).toBe('Original')
      expect(result.type).toBe('inproceedings')
    })
  })

  describe('findDuplicates', () => {
    it('finds duplicates by DOI exact match', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { doi: '10.1234/test', title: 'Paper A', year: '2020' } },
        { key: 'B', type: 'article', fields: { doi: '10.1234/test', title: 'Paper B', year: '2021' } },
        { key: 'C', type: 'article', fields: { doi: '10.5678/other', title: 'Paper C', year: '2020' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('doi')
      expect(groups[0].entries).toHaveLength(2)
      expect(groups[0].entries.map(e => e.key)).toContain('A')
      expect(groups[0].entries.map(e => e.key)).toContain('B')
    })

    it('finds duplicates by title+year fuzzy match', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { title: 'Deep Learning for NLP', year: '2020' } },
        { key: 'B', type: 'article', fields: { title: 'deep learning for nlp', year: '2020' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('title_year')
      expect(groups[0].entries).toHaveLength(2)
    })

    it('returns empty array when no duplicates exist', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { title: 'Paper A', year: '2020' } },
        { key: 'B', type: 'article', fields: { title: 'Paper B', year: '2021' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(0)
    })

    it('DOI match takes precedence over title+year', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { doi: '10.1234/x', title: 'Same Title', year: '2020' } },
        { key: 'B', type: 'article', fields: { doi: '10.1234/x', title: 'Same Title', year: '2020' } },
      ]
      const groups = findDuplicates(entries)
      // Should only produce one group (DOI), not a second title_year group
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('doi')
    })

    it('handles entries without DOI or title', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { author: 'Smith' } },
        { key: 'B', type: 'article', fields: { author: 'Jones' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(0)
    })

    it('DOI matching is case-insensitive', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { doi: '10.1234/ABC' } },
        { key: 'B', type: 'article', fields: { doi: '10.1234/abc' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('doi')
    })

    it('title+year match ignores punctuation differences', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { title: 'Machine Learning: A Survey', year: '2020' } },
        { key: 'B', type: 'article', fields: { title: 'Machine Learning A Survey', year: '2020' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('title_year')
    })
  })

  describe('sortEntries', () => {
    const entries = [
      { key: 'Zeta2020', type: 'article', fields: { author: 'Charlie', year: '2021' } },
      { key: 'Alpha2019', type: 'article', fields: { author: 'Alice', year: '2019' } },
      { key: 'Mid2020', type: 'article', fields: { author: 'Bob', year: '2020' } },
    ]

    it('sorts by key alphabetically', () => {
      const sorted = sortEntries(entries, 'key')
      expect(sorted.map(e => e.key)).toEqual(['Alpha2019', 'Mid2020', 'Zeta2020'])
    })

    it('sorts by year ascending', () => {
      const sorted = sortEntries(entries, 'year')
      expect(sorted.map(e => e.fields.year)).toEqual(['2019', '2020', '2021'])
    })

    it('sorts by author alphabetically', () => {
      const sorted = sortEntries(entries, 'author')
      expect(sorted.map(e => e.fields.author)).toEqual(['Alice', 'Bob', 'Charlie'])
    })

    it('defaults to key sort when no order specified', () => {
      const sorted = sortEntries(entries)
      expect(sorted.map(e => e.key)).toEqual(['Alpha2019', 'Mid2020', 'Zeta2020'])
    })

    it('does not mutate the original array', () => {
      const original = [...entries]
      sortEntries(entries, 'year')
      expect(entries.map(e => e.key)).toEqual(original.map(e => e.key))
    })

    it('handles entries with missing year', () => {
      const withMissing = [
        { key: 'A', type: 'article', fields: { year: '2020' } },
        { key: 'B', type: 'article', fields: {} },
        { key: 'C', type: 'article', fields: { year: '2019' } },
      ]
      const sorted = sortEntries(withMissing, 'year')
      // Missing year parsed as 0, so it goes first
      expect(sorted.map(e => e.key)).toEqual(['B', 'C', 'A'])
    })

    it('handles entries with missing author', () => {
      const withMissing = [
        { key: 'A', type: 'article', fields: { author: 'Zack' } },
        { key: 'B', type: 'article', fields: {} },
      ]
      const sorted = sortEntries(withMissing, 'author')
      // Missing author is '', which sorts before 'Zack'
      expect(sorted.map(e => e.key)).toEqual(['B', 'A'])
    })
  })

  describe('formatBibTeX', () => {
    it('converts article metadata to BibTeX', () => {
      const metadata = {
        title: 'Deep Learning Survey',
        authors: ['John Smith', 'Jane Doe'],
        year: 2020,
        journal: 'Nature',
        doi: '10.1234/test',
      }
      const result = formatBibTeX(metadata)
      expect(result).toContain('@article{Smith2020,')
      expect(result).toContain('author = {John Smith and Jane Doe}')
      expect(result).toContain('title = {Deep Learning Survey}')
      expect(result).toContain('year = {2020}')
      expect(result).toContain('journal = {Nature}')
      expect(result).toContain('doi = {10.1234/test}')
    })

    it('uses inproceedings type for conference papers with booktitle', () => {
      const metadata = {
        title: 'A Conference Paper',
        authors: ['Alice'],
        year: 2021,
        booktitle: 'ICML 2021',
      }
      const result = formatBibTeX(metadata)
      expect(result).toContain('@inproceedings{Alice2021,')
      expect(result).toContain('booktitle = {ICML 2021}')
    })

    it('uses inproceedings type for venue without journal', () => {
      const metadata = {
        title: 'Venue Paper',
        authors: ['Bob'],
        year: 2022,
        venue: 'NeurIPS',
      }
      const result = formatBibTeX(metadata)
      expect(result).toContain('@inproceedings{')
      expect(result).toContain('booktitle = {NeurIPS}')
    })

    it('uses article type with journal field when journal is present', () => {
      const metadata = {
        title: 'Journal Paper',
        author: 'Carol White',
        year: 2020,
        journal: 'Science',
        venue: 'SomeVenue',
      }
      const result = formatBibTeX(metadata)
      expect(result).toContain('@article{')
      expect(result).toContain('journal = {Science}')
    })

    it('includes optional fields when present', () => {
      const metadata = {
        title: 'Full Paper',
        authors: ['Author'],
        year: 2020,
        journal: 'J',
        volume: '10',
        number: '3',
        pages: '1-20',
        url: 'https://example.com',
        abstract: 'An abstract.',
      }
      const result = formatBibTeX(metadata)
      expect(result).toContain('volume = {10}')
      expect(result).toContain('number = {3}')
      expect(result).toContain('pages = {1-20}')
      expect(result).toContain('url = {https://example.com}')
      expect(result).toContain('abstract = {An abstract.}')
    })

    it('handles metadata with only author string (not array)', () => {
      const metadata = {
        title: 'Solo Author',
        author: 'Single Author',
        year: 2020,
      }
      const result = formatBibTeX(metadata)
      expect(result).toContain('author = {Single Author}')
    })

    it('handles metadata with minimal fields', () => {
      const metadata = { title: 'Minimal' }
      const result = formatBibTeX(metadata)
      expect(result).toContain('@article{')
      expect(result).toContain('title = {Minimal}')
    })
  })

  describe('parseBibFile — edge cases (Codex review)', () => {
    it('parses fields with = inside URL values', () => {
      const bib = `@article{Test2023,
  author = {Doe},
  title = {Test},
  year = {2023},
  url = {https://example.com/path?key=value&foo=bar}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].fields.url).toBe('https://example.com/path?key=value&foo=bar')
      expect(entries[0].fields.author).toBe('Doe')
      expect(entries[0].fields.title).toBe('Test')
    })

    it('parses fields with = inside abstract values', () => {
      const bib = `@article{Abs2023,
  author = {Smith},
  title = {Equations},
  year = {2023},
  abstract = {We show x = y and a = b + c in this paper.}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].fields.abstract).toBe('We show x = y and a = b + c in this paper.')
    })

    it('parses DOI field with = in URL prefix', () => {
      const bib = `@article{Doi2023,
  author = {Jane},
  doi = {https://doi.org/10.1234/test=value},
  title = {Doi Test},
  year = {2023}
}`
      const entries = parseBibFile(bib)
      expect(entries).toHaveLength(1)
      expect(entries[0].fields.doi).toBe('https://doi.org/10.1234/test=value')
    })

    it('skips @string and @preamble entries', () => {
      const bib = `@string{Nature = {Nature Publishing Group}}

@preamble{"Some preamble"}

@article{Real2023,
  author = {Test},
  title = {Real Entry},
  year = {2023}
}`
      const entries = parseBibFile(bib)
      // @string/@preamble don't match "key," format, should be skipped
      expect(entries.every(e => e.type !== 'string' && e.type !== 'preamble')).toBe(true)
      const real = entries.find(e => e.key === 'Real2023')
      expect(real).toBeDefined()
      expect(real.fields.title).toBe('Real Entry')
    })
  })

  describe('findDuplicates — DOI normalization', () => {
    it('detects duplicates with different DOI URL formats', () => {
      const entries = [
        { key: 'A', type: 'article', fields: { doi: '10.1000/abc', title: 'Paper A', year: '2020' } },
        { key: 'B', type: 'article', fields: { doi: 'https://doi.org/10.1000/abc', title: 'Different Title', year: '2021' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('doi')
    })

    it('detects duplicates with case-insensitive DOI', () => {
      const entries = [
        { key: 'C', type: 'article', fields: { doi: '10.1000/ABC', title: 'Paper C', year: '2020' } },
        { key: 'D', type: 'article', fields: { doi: '10.1000/abc', title: 'Paper D', year: '2020' } },
      ]
      const groups = findDuplicates(entries)
      expect(groups).toHaveLength(1)
      expect(groups[0].reason).toBe('doi')
    })
  })
})
