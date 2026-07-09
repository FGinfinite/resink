import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock @overleaf/settings (used by truncation utility which is imported transitively)
vi.mock('@overleaf/settings', () => ({
  default: {},
}))

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

const { readFile } = await import('node:fs/promises')

const {
  loadTemplate,
  injectVariables,
  buildSystemPrompt,
  clearTemplateCache,
} = await import(
  '../../../../app/js/prompt/system.js'
)

describe('Prompt system', () => {
  beforeEach(() => {
    clearTemplateCache()
    vi.mocked(readFile).mockReset()
  })

  afterEach(() => {
    clearTemplateCache()
  })

  describe('loadTemplate', () => {
    it('loads template file', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('Hello {{name}}, welcome!')

      const result = await loadTemplate('base')

      expect(result).toBe('Hello {{name}}, welcome!')
      expect(readFile).toHaveBeenCalledTimes(1)
      // Verify it reads from the correct path (templates directory with .txt extension)
      const callPath = vi.mocked(readFile).mock.calls[0][0]
      expect(callPath).toContain('templates')
      expect(callPath).toContain('base.txt')
    })

    it('caches loaded templates', async () => {
      vi.mocked(readFile).mockResolvedValueOnce('Cached template')

      const result1 = await loadTemplate('cached')
      const result2 = await loadTemplate('cached')

      expect(result1).toBe('Cached template')
      expect(result2).toBe('Cached template')
      // readFile should only be called once due to caching
      expect(readFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('injectVariables', () => {
    it('replaces {{var}} patterns', () => {
      const template = 'Hello {{name}}, you are a {{role}}.'
      const result = injectVariables(template, {
        name: 'Alice',
        role: 'writer',
      })

      expect(result).toBe('Hello Alice, you are a writer.')
    })

    it('replaces multiple occurrences of the same variable', () => {
      const template = '{{name}} is great. {{name}} is awesome.'
      const result = injectVariables(template, { name: 'Bob' })

      expect(result).toBe('Bob is great. Bob is awesome.')
    })

    it('handles missing variables by leaving them as-is', () => {
      const template = 'Hello {{name}}, your id is {{id}}.'
      const result = injectVariables(template, { name: 'Alice' })

      expect(result).toBe('Hello Alice, your id is {{id}}.')
    })

    it('handles null/undefined values by replacing with empty string', () => {
      const template = 'Value: {{val}}'
      const result = injectVariables(template, { val: null })

      expect(result).toBe('Value: ')
    })

    it('handles empty variables object', () => {
      const template = 'No {{vars}} here.'
      const result = injectVariables(template, {})

      expect(result).toBe('No {{vars}} here.')
    })
  })

  describe('buildSystemPrompt', () => {
    it('combines all templates', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce('Base template content')
        .mockResolvedValueOnce('LaTeX template content')
        .mockResolvedValueOnce('Tools template content')
        .mockResolvedValueOnce('Safety template content')

      const result = await buildSystemPrompt()

      expect(result).toContain('Base template content')
      expect(result).toContain('LaTeX template content')
      expect(result).toContain('Tools template content')
      expect(result).toContain('Safety template content')
      // Templates are joined by separator
      expect(result).toContain('---')
    })

    it('adds project context', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce('Base')
        .mockResolvedValueOnce('LaTeX')
        .mockResolvedValueOnce('Tools')
        .mockResolvedValueOnce('Safety')

      const result = await buildSystemPrompt({
        projectName: 'My Thesis',
        rootDocPath: '/main.tex',
        documentOutline: '\\section{Introduction} (L1)',
      })

      expect(result).toContain('Project: My Thesis')
      expect(result).toContain('Main document: main.tex')
      expect(result).toContain('## Document Outline (main.tex)')
      expect(result).toContain('\\section{Introduction} (L1)')
    })

    it('skips missing template files (ENOENT)', async () => {
      const enoentError = new Error('File not found')
      enoentError.code = 'ENOENT'

      vi.mocked(readFile)
        .mockResolvedValueOnce('Base content')
        .mockRejectedValueOnce(enoentError)
        .mockResolvedValueOnce('Tools content')
        .mockResolvedValueOnce('Safety content')

      const result = await buildSystemPrompt()

      expect(result).toContain('Base content')
      expect(result).toContain('Tools content')
      expect(result).toContain('Safety content')
    })

    it('throws on non-ENOENT errors', async () => {
      const permError = new Error('Permission denied')
      permError.code = 'EACCES'

      vi.mocked(readFile)
        .mockResolvedValueOnce('Base')
        .mockRejectedValueOnce(permError)

      try {
        await buildSystemPrompt()
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error.message).toBe('Permission denied')
      }
    })

    it('injects variables into templates', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce('Project: {{projectId}}')
        .mockResolvedValueOnce('LaTeX for {{projectId}}')
        .mockResolvedValueOnce('Tools')
        .mockResolvedValueOnce('Safety')

      const result = await buildSystemPrompt({ projectId: 'my-proj' })

      expect(result).toContain('Project: my-proj')
      expect(result).toContain('LaTeX for my-proj')
    })

    it('injects agentContextBlock before Project Context', async () => {
      vi.mocked(readFile)
        .mockResolvedValueOnce('Base')
        .mockResolvedValueOnce('LaTeX')
        .mockResolvedValueOnce('Tools')
        .mockResolvedValueOnce('Safety')

      const result = await buildSystemPrompt({
        agentContextBlock: '<agent_context>\n<context data>\n</agent_context>',
        projectName: 'Thesis',
      })

      expect(result).toContain('<agent_context>')
      const contextBlockIdx = result.indexOf('<agent_context>')
      const projectContextIdx = result.indexOf('# Project Context')
      expect(contextBlockIdx).toBeLessThan(projectContextIdx)
    })
  })

  describe('clearTemplateCache', () => {
    it('clears cache so templates are reloaded', async () => {
      vi.mocked(readFile).mockResolvedValue('Template v1')

      await loadTemplate('test')
      expect(readFile).toHaveBeenCalledTimes(1)

      // Without clearing, this uses cache
      await loadTemplate('test')
      expect(readFile).toHaveBeenCalledTimes(1)

      // After clearing, readFile should be called again
      clearTemplateCache()
      vi.mocked(readFile).mockResolvedValue('Template v2')

      const result = await loadTemplate('test')
      expect(readFile).toHaveBeenCalledTimes(2)
      expect(result).toBe('Template v2')
    })
  })
})
