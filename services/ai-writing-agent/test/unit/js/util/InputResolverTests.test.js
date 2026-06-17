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

const { resolveInputs } = await import(
  '../../../../app/js/util/input-resolver.js'
)

describe('input-resolver.js', () => {
  let readFn

  beforeEach(() => {
    readFn = vi.fn()
  })

  describe('resolveInputs', () => {
    it('resolves a single file with no inputs', async () => {
      readFn.mockResolvedValueOnce({
        content: '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}',
        docId: 'doc-1',
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(1)
      expect(result.files[0].path).toBe('/main.tex')
      expect(result.files[0].docId).toBe('doc-1')
      expect(result.errors).toHaveLength(0)
      expect(result.tree.path).toBe('/main.tex')
      expect(result.tree.children).toHaveLength(0)
    })

    it('resolves nested \\input directives', async () => {
      readFn
        .mockImplementation(async (filePath) => {
          if (filePath === '/main.tex') {
            return {
              content: '\\documentclass{article}\n\\input{chapters/intro}\n\\end{document}',
              docId: 'doc-main',
            }
          }
          if (filePath === '/chapters/intro.tex') {
            return {
              content: '\\section{Introduction}\nHello world.',
              docId: 'doc-intro',
            }
          }
          return null
        })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files[0].path).toBe('/main.tex')
      expect(result.files[1].path).toBe('/chapters/intro.tex')
      expect(result.errors).toHaveLength(0)
      expect(result.tree.children).toHaveLength(1)
      expect(result.tree.children[0].path).toBe('/chapters/intro.tex')
    })

    it('resolves deeply nested inputs', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{a}', docId: 'doc-main' }
        }
        if (filePath === '/a.tex') {
          return { content: '\\input{b}', docId: 'doc-a' }
        }
        if (filePath === '/b.tex') {
          return { content: 'leaf content', docId: 'doc-b' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(3)
      expect(result.files.map(f => f.path)).toEqual(['/main.tex', '/a.tex', '/b.tex'])
      expect(result.errors).toHaveLength(0)
    })

    it('detects circular references', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{a}', docId: 'doc-main' }
        }
        if (filePath === '/a.tex') {
          return { content: '\\input{main}', docId: 'doc-a' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.some(e => e.includes('Circular reference'))).toBe(true)
      // main.tex and a.tex should still be in files (resolved before circular detected)
      expect(result.files).toHaveLength(2)
    })

    it('handles missing files gracefully', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{missing}', docId: 'doc-main' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(1) // only main.tex
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.some(e => e.includes('File not found'))).toBe(true)
    })

    it('auto-appends .tex extension when missing', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{chapter1}', docId: 'doc-main' }
        }
        if (filePath === '/chapter1.tex') {
          return { content: 'Chapter 1 content', docId: 'doc-ch1' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files[1].path).toBe('/chapter1.tex')
      expect(result.errors).toHaveLength(0)
    })

    it('does not append .tex when extension already present', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{data.csv}', docId: 'doc-main' }
        }
        if (filePath === '/data.csv') {
          return { content: 'a,b,c', docId: 'doc-csv' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files[1].path).toBe('/data.csv')
    })

    it('reports error when max depth exceeded', async () => {
      // Create a chain: main -> a -> b -> c -> d -> e -> f (depth 5 exceeded at e)
      readFn.mockImplementation(async (filePath) => {
        const chain = {
          '/main.tex': { content: '\\input{a}', docId: 'd0' },
          '/a.tex': { content: '\\input{b}', docId: 'd1' },
          '/b.tex': { content: '\\input{c}', docId: 'd2' },
          '/c.tex': { content: '\\input{d}', docId: 'd3' },
          '/d.tex': { content: '\\input{e}', docId: 'd4' },
          '/e.tex': { content: '\\input{f}', docId: 'd5' },
          '/f.tex': { content: 'leaf', docId: 'd6' },
        }
        return chain[filePath] || null
      })

      const result = await resolveInputs('main.tex', readFn, { maxDepth: 3 })

      expect(result.errors.some(e => e.includes('Max depth exceeded'))).toBe(true)
    })

    it('does not follow inputs when followInputs=false', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{chapter}\nSome text', docId: 'doc-main' }
        }
        if (filePath === '/chapter.tex') {
          return { content: 'Chapter content', docId: 'doc-ch' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn, { followInputs: false })

      expect(result.files).toHaveLength(1)
      expect(result.files[0].path).toBe('/main.tex')
      expect(result.tree.children).toHaveLength(0)
      expect(result.errors).toHaveLength(0)
    })

    it('handles \\include directives the same as \\input', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\include{appendix}', docId: 'doc-main' }
        }
        if (filePath === '/appendix.tex') {
          return { content: 'Appendix content', docId: 'doc-app' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files[1].path).toBe('/appendix.tex')
    })

    it('resolves paths relative to the including file', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{chapters/ch1}', docId: 'doc-main' }
        }
        if (filePath === '/chapters/ch1.tex') {
          return { content: '\\input{sections/sec1}', docId: 'doc-ch1' }
        }
        if (filePath === '/chapters/sections/sec1.tex') {
          return { content: 'Section 1 content', docId: 'doc-sec1' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(3)
      expect(result.files[2].path).toBe('/chapters/sections/sec1.tex')
      expect(result.errors).toHaveLength(0)
    })

    it('ignores commented-out \\input commands', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return {
            content: '% \\input{commented}\n\\input{real}',
            docId: 'doc-main',
          }
        }
        if (filePath === '/real.tex') {
          return { content: 'Real content', docId: 'doc-real' }
        }
        if (filePath === '/commented.tex') {
          return { content: 'Should not be read', docId: 'doc-commented' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files.map(f => f.path)).toEqual(['/main.tex', '/real.tex'])
    })

    it('normalizes entry path to start with /', async () => {
      readFn.mockResolvedValueOnce({
        content: 'Hello',
        docId: 'doc-1',
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files[0].path).toBe('/main.tex')
      expect(result.tree.path).toBe('/main.tex')
    })

    it('handles entry file not found', async () => {
      readFn.mockResolvedValueOnce(null)

      const result = await resolveInputs('nonexistent.tex', readFn)

      expect(result.files).toHaveLength(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('File not found')
    })

    it('handles multiple \\input on the same line', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{a}\\input{b}', docId: 'doc-main' }
        }
        if (filePath === '/a.tex') {
          return { content: 'Content A', docId: 'doc-a' }
        }
        if (filePath === '/b.tex') {
          return { content: 'Content B', docId: 'doc-b' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(3)
      expect(result.files.map(f => f.path)).toContain('/a.tex')
      expect(result.files.map(f => f.path)).toContain('/b.tex')
    })

    it('allows the same file to be \\input from multiple places (not a cycle)', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return {
            content: '\\input{shared}\n\\input{chapter}\n',
            docId: 'doc-main',
          }
        }
        if (filePath === '/shared.tex') {
          return { content: 'Shared macros', docId: 'doc-shared' }
        }
        if (filePath === '/chapter.tex') {
          return { content: '\\input{shared}', docId: 'doc-chapter' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      // shared.tex should appear in files only once (deduped)
      expect(result.files.filter(f => f.path === '/shared.tex')).toHaveLength(1)
      // No circular reference error
      expect(result.errors.filter(e => e.includes('Circular'))).toHaveLength(0)
      // Total: main + shared + chapter = 3
      expect(result.files).toHaveLength(3)
    })

    it('rejects path traversal with ../', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{../../etc/passwd}', docId: 'doc-main' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.errors.some(e => e.includes('Path traversal rejected'))).toBe(true)
    })

    it('handles whitespace between \\input and brace (Codex round 2)', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input {chapter}', docId: 'doc-main' }
        }
        if (filePath === '/chapter.tex') {
          return { content: 'Chapter content', docId: 'doc-ch' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files[1].path).toBe('/chapter.tex')
    })

    it('excludes \\input inside verbatim environment (Codex round 2)', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return {
            content: [
              '\\input{real}',
              '\\begin{verbatim}',
              '\\input{fake}',
              '\\end{verbatim}',
            ].join('\n'),
            docId: 'doc-main',
          }
        }
        if (filePath === '/real.tex') {
          return { content: 'Real content', docId: 'doc-real' }
        }
        if (filePath === '/fake.tex') {
          return { content: 'Should not be resolved', docId: 'doc-fake' }
        }
        return null
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(2)
      expect(result.files.map(f => f.path)).toEqual(['/main.tex', '/real.tex'])
    })

    it('handles readFn throwing an exception (Codex round 2)', async () => {
      readFn.mockImplementation(async (filePath) => {
        if (filePath === '/main.tex') {
          return { content: '\\input{broken}', docId: 'doc-main' }
        }
        throw new Error('Network error')
      })

      const result = await resolveInputs('main.tex', readFn)

      expect(result.files).toHaveLength(1)
      expect(result.errors.some(e => e.includes('Error reading') && e.includes('Network error'))).toBe(true)
    })
  })
})
