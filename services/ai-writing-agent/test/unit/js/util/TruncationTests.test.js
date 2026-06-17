import { describe, it, expect, vi } from 'vitest'

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

const {
  truncateByLines,
  truncateByLength,
  truncateByLinesAndChars,
  extractLatexSection,
} = await import('../../../../app/js/util/truncation.js')

describe('truncation.js', () => {
  describe('truncateByLines', () => {
    it('does not truncate short text', () => {
      const result = truncateByLines('line1\nline2\nline3', 10)
      expect(result.truncated).toBe(false)
      expect(result.totalLines).toBe(3)
    })

    it('truncates long text', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`)
      const result = truncateByLines(lines.join('\n'), 5)
      expect(result.truncated).toBe(true)
      expect(result.text.split('\n')).toHaveLength(5)
      expect(result.totalLines).toBe(20)
    })
  })

  describe('truncateByLength', () => {
    it('does not truncate short text', () => {
      const result = truncateByLength('short', 100)
      expect(result.truncated).toBe(false)
    })

    it('truncates long text', () => {
      const result = truncateByLength('a'.repeat(200), 100)
      expect(result.truncated).toBe(true)
      expect(result.text.length).toBe(100)
      expect(result.totalLength).toBe(200)
    })
  })

  describe('truncateByLinesAndChars', () => {
    it('does not truncate when within both limits', () => {
      const text = 'line1\nline2\nline3'
      const result = truncateByLinesAndChars(text, 10, 10000)
      expect(result.truncated).toBe(false)
      expect(result.truncatedAtLine).toBe(3)
    })

    it('truncates by line count when lines exceeded first', () => {
      const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`)
      const result = truncateByLinesAndChars(lines.join('\n'), 5, 100000)
      expect(result.truncated).toBe(true)
      expect(result.truncatedAtLine).toBe(5)
      expect(result.text.split('\n')).toHaveLength(5)
    })

    it('truncates by char count when chars exceeded first', () => {
      // Each line is ~10 chars, 20 lines = ~200 chars
      const lines = Array.from({ length: 20 }, (_, i) => `Line__${String(i).padStart(3, '0')}`)
      const text = lines.join('\n')
      const result = truncateByLinesAndChars(text, 100, 50) // char limit hit first
      expect(result.truncated).toBe(true)
      expect(result.truncatedAtLine).toBeLessThan(20)
      expect(result.text.length).toBeLessThanOrEqual(50 + 20) // some tolerance for last line
    })

    it('returns correct totalLines and totalChars', () => {
      const text = 'a\nb\nc\nd\ne'
      const result = truncateByLinesAndChars(text, 3, 10000)
      expect(result.totalLines).toBe(5)
      expect(result.totalChars).toBe(text.length)
      expect(result.truncated).toBe(true)
      expect(result.truncatedAtLine).toBe(3)
    })

    it('handles single line text', () => {
      const result = truncateByLinesAndChars('hello', 10, 10000)
      expect(result.truncated).toBe(false)
      expect(result.truncatedAtLine).toBe(1)
    })
  })

  describe('extractLatexSection (level-aware)', () => {
    it('extracts a simple section', () => {
      const content = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        'Intro text.',
        '\\section{Methods}',
        'Methods text.',
        '\\end{document}',
      ].join('\n')

      const result = extractLatexSection(content, 'Introduction')
      expect(result.found).toBe(true)
      expect(result.content).toContain('Intro text.')
      expect(result.content).not.toContain('Methods text.')
      expect(result.startLine).toBe(3) // 1-based
      expect(result.command).toBe('section')
    })

    it('returns not found for missing section', () => {
      const content = '\\section{A}\ntext'
      const result = extractLatexSection(content, 'Missing')
      expect(result.found).toBe(false)
    })

    it('chapter includes inner sections (level-aware fix)', () => {
      const content = [
        '\\chapter{Literature Review}',  // L1
        'Chapter intro.',                   // L2
        '\\section{Related Work}',          // L3
        'Related work text.',                // L4
        '\\section{Gap Analysis}',           // L5
        'Gap text.',                          // L6
        '\\chapter{Methodology}',            // L7
        'Methods intro.',                     // L8
      ].join('\n')

      const result = extractLatexSection(content, 'Literature Review')
      expect(result.found).toBe(true)
      expect(result.content).toContain('Related work text.')
      expect(result.content).toContain('Gap text.')
      expect(result.content).not.toContain('Methods intro.')
      expect(result.command).toBe('chapter')
    })

    it('section stops at same-level section', () => {
      const content = [
        '\\section{A}',
        'A text.',
        '\\section{B}',
        'B text.',
      ].join('\n')

      const result = extractLatexSection(content, 'A')
      expect(result.found).toBe(true)
      expect(result.content).toContain('A text.')
      expect(result.content).not.toContain('B text.')
    })

    it('section stops at higher-level command', () => {
      const content = [
        '\\section{Deep Section}',
        'Deep text.',
        '\\chapter{New Chapter}',
        'Chapter text.',
      ].join('\n')

      const result = extractLatexSection(content, 'Deep Section')
      expect(result.found).toBe(true)
      expect(result.content).toContain('Deep text.')
      expect(result.content).not.toContain('Chapter text.')
    })

    it('subsection includes subsubsection', () => {
      const content = [
        '\\subsection{Data}',
        'Data intro.',
        '\\subsubsection{Collection}',
        'Collection text.',
        '\\subsubsection{Processing}',
        'Processing text.',
        '\\subsection{Analysis}',
        'Analysis text.',
      ].join('\n')

      const result = extractLatexSection(content, 'Data')
      expect(result.found).toBe(true)
      expect(result.content).toContain('Collection text.')
      expect(result.content).toContain('Processing text.')
      expect(result.content).not.toContain('Analysis text.')
      expect(result.command).toBe('subsection')
    })

    it('is case-insensitive', () => {
      const content = '\\section{Introduction}\ntext'
      const result = extractLatexSection(content, 'introduction')
      expect(result.found).toBe(true)
    })
  })
})
