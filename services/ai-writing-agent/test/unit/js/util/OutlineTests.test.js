import { describe, it, expect } from 'vitest'
import {
  extractOutlineEntries,
  formatOutlineEntries,
  extractOutline,
  generateTruncationOutline,
} from '../../../../app/js/util/outline.js'

describe('outline.js', () => {
  describe('extractOutlineEntries', () => {
    it('returns null for empty document', () => {
      expect(extractOutlineEntries('')).toBeNull()
    })

    it('returns null for document without sections', () => {
      const content = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}'
      expect(extractOutlineEntries(content)).toBeNull()
    })

    it('extracts entries with correct startLine', () => {
      const content = [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\section{Introduction}',
        'Some text.',
        '\\section{Methods}',
        'More text.',
        '\\end{document}',
      ].join('\n')

      const entries = extractOutlineEntries(content)
      expect(entries).toHaveLength(2)
      expect(entries[0].command).toBe('section')
      expect(entries[0].title).toBe('Introduction')
      expect(entries[0].startLine).toBe(3)
      expect(entries[1].command).toBe('section')
      expect(entries[1].title).toBe('Methods')
      expect(entries[1].startLine).toBe(5)
    })

    it('computes endLine correctly for same-level sections', () => {
      const content = [
        '\\section{A}',
        'text a',
        '\\section{B}',
        'text b',
        '\\section{C}',
        'text c',
      ].join('\n')

      const entries = extractOutlineEntries(content)
      expect(entries).toHaveLength(3)
      expect(entries[0].endLine).toBe(2) // A ends before B
      expect(entries[1].endLine).toBe(4) // B ends before C
      expect(entries[2].endLine).toBe(6) // C goes to end
    })

    it('computes endLine correctly for nested hierarchy', () => {
      const content = [
        '\\chapter{Ch1}',       // L1
        'intro text',            // L2
        '\\section{S1}',        // L3
        'section text',          // L4
        '\\subsection{SS1}',    // L5
        'subsection text',       // L6
        '\\section{S2}',        // L7
        'section 2 text',        // L8
        '\\chapter{Ch2}',       // L9
        'chapter 2 text',        // L10
      ].join('\n')

      const entries = extractOutlineEntries(content)
      expect(entries).toHaveLength(5)

      // Ch1 ends before Ch2
      expect(entries[0].command).toBe('chapter')
      expect(entries[0].title).toBe('Ch1')
      expect(entries[0].endLine).toBe(8)

      // S1 ends before S2
      expect(entries[1].command).toBe('section')
      expect(entries[1].title).toBe('S1')
      expect(entries[1].endLine).toBe(6)

      // SS1 ends before S2 (S2 is higher level)
      expect(entries[2].command).toBe('subsection')
      expect(entries[2].title).toBe('SS1')
      expect(entries[2].endLine).toBe(6)

      // S2 ends before Ch2
      expect(entries[3].command).toBe('section')
      expect(entries[3].title).toBe('S2')
      expect(entries[3].endLine).toBe(8)

      // Ch2 goes to end
      expect(entries[4].command).toBe('chapter')
      expect(entries[4].title).toBe('Ch2')
      expect(entries[4].endLine).toBe(10)
    })

    it('computes lineCount correctly', () => {
      const content = [
        '\\section{A}',
        'line 2',
        'line 3',
        '\\section{B}',
        'line 5',
      ].join('\n')

      const entries = extractOutlineEntries(content)
      expect(entries[0].lineCount).toBe(3) // L1-L3
      expect(entries[1].lineCount).toBe(2) // L4-L5
    })

    it('ignores commented-out sections', () => {
      const content = [
        '% \\section{Commented}',
        '\\section{Real}',
        'text',
      ].join('\n')

      const entries = extractOutlineEntries(content)
      expect(entries).toHaveLength(1)
      expect(entries[0].title).toBe('Real')
    })

    it('handles starred sections', () => {
      const content = '\\section*{Unnumbered}\ntext'
      const entries = extractOutlineEntries(content)
      expect(entries).toHaveLength(1)
      expect(entries[0].title).toBe('Unnumbered')
    })
  })

  describe('formatOutlineEntries', () => {
    it('returns null for null/empty entries', () => {
      expect(formatOutlineEntries(null)).toBeNull()
      expect(formatOutlineEntries([])).toBeNull()
    })

    it('formats entries with line ranges and line counts', () => {
      const entries = [
        { level: 2, command: 'section', title: 'Intro', startLine: 1, endLine: 20, lineCount: 20 },
        { level: 2, command: 'section', title: 'Methods', startLine: 21, endLine: 50, lineCount: 30 },
      ]

      const result = formatOutlineEntries(entries)
      expect(result).toContain('\\section{Intro} (L1–L20, 20 lines)')
      expect(result).toContain('\\section{Methods} (L21–L50, 30 lines)')
    })

    it('indents nested levels', () => {
      const entries = [
        { level: 1, command: 'chapter', title: 'Ch1', startLine: 1, endLine: 50, lineCount: 50 },
        { level: 2, command: 'section', title: 'S1', startLine: 2, endLine: 30, lineCount: 29 },
      ]

      const result = formatOutlineEntries(entries)
      const lines = result.split('\n')
      expect(lines[0]).toMatch(/^\\chapter/)
      expect(lines[1]).toMatch(/^  \\section/)
    })

    it('filters by fromLine', () => {
      const entries = [
        { level: 2, command: 'section', title: 'A', startLine: 1, endLine: 20, lineCount: 20 },
        { level: 2, command: 'section', title: 'B', startLine: 21, endLine: 50, lineCount: 30 },
        { level: 2, command: 'section', title: 'C', startLine: 51, endLine: 80, lineCount: 30 },
      ]

      const result = formatOutlineEntries(entries, { fromLine: 25 })
      expect(result).not.toContain('section{A}')
      expect(result).toContain('section{B}')
      expect(result).toContain('section{C}')
    })
  })

  describe('extractOutline', () => {
    it('returns null for no sections', () => {
      expect(extractOutline('Hello world')).toBeNull()
    })

    it('returns formatted string for document with sections', () => {
      const content = [
        '\\section{Introduction}',
        'text',
        '\\section{Methods}',
        'text',
      ].join('\n')

      const result = extractOutline(content)
      expect(result).toContain('\\section{Introduction}')
      expect(result).toContain('\\section{Methods}')
      expect(result).toContain('lines)')
    })
  })

  describe('generateTruncationOutline', () => {
    it('returns null for no sections', () => {
      expect(generateTruncationOutline('Hello world', 1)).toBeNull()
    })

    it('returns null when no sections after fromLine', () => {
      const content = '\\section{Only}\ntext\nmore text'
      expect(generateTruncationOutline(content, 10)).toBeNull()
    })

    it('returns sections starting at or after fromLine', () => {
      const content = [
        '\\section{A}',       // L1
        'text a',              // L2
        '\\section{B}',       // L3
        'text b',              // L4
        '\\section{C}',       // L5
        'text c',              // L6
      ].join('\n')

      const result = generateTruncationOutline(content, 3)
      expect(result).toContain('\\section{B}')
      expect(result).toContain('\\section{C}')
      expect(result).not.toContain('\\section{A}')
    })

    it('uses compact format without lineCount', () => {
      const content = [
        '\\section{A}',
        'text',
        '\\section{B}',
        'text',
      ].join('\n')

      const result = generateTruncationOutline(content, 3)
      // Should have line range but not lineCount
      expect(result).toMatch(/L\d+–L\d+\)/)
      expect(result).not.toContain('lines)')
    })
  })
})
