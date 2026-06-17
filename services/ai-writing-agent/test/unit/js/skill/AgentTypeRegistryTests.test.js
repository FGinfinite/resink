import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const { AgentTypeRegistry } = await import(
  '../../../../app/js/skill/AgentTypeRegistry.js'
)

describe('AgentTypeRegistry', () => {
  describe('_parseFrontmatter', () => {
    let registry

    beforeEach(() => {
      registry = new AgentTypeRegistry()
    })

    it('parses name, description, tools, and maxTurns from frontmatter', () => {
      const content = [
        '---',
        'name: test-agent',
        'description: A test agent',
        'tools: read_document, list_files, search_project',
        'maxTurns: 3',
        '---',
        '',
        'This is the body.',
      ].join('\n')

      const result = registry._parseFrontmatter(content)

      expect(result.name).toBe('test-agent')
      expect(result.description).toBe('A test agent')
      expect(result.tools).toEqual(['read_document', 'list_files', 'search_project'])
      expect(result.maxTurns).toBe(3)
      expect(result.body).toBe('This is the body.')
    })

    it('parses tools with extra whitespace', () => {
      const content = [
        '---',
        'name: agent',
        'tools:  read_document ,  list_files ',
        '---',
        '',
        'Body text.',
      ].join('\n')

      const result = registry._parseFrontmatter(content)

      expect(result.tools).toEqual(['read_document', 'list_files'])
    })

    it('defaults maxTurns to 5 when not specified', () => {
      const content = [
        '---',
        'name: agent',
        'tools: read_document',
        '---',
        '',
        'Body.',
      ].join('\n')

      const result = registry._parseFrontmatter(content)

      expect(result.maxTurns).toBe(5)
    })

    it('defaults maxTurns to 5 when invalid value', () => {
      const content = [
        '---',
        'name: agent',
        'maxTurns: not-a-number',
        '---',
        '',
        'Body.',
      ].join('\n')

      const result = registry._parseFrontmatter(content)

      expect(result.maxTurns).toBe(5)
    })

    it('returns full content as body when no frontmatter', () => {
      const content = 'Just plain text without frontmatter.'
      const result = registry._parseFrontmatter(content)

      expect(result.name).toBe('')
      expect(result.body).toBe(content)
    })

    it('handles empty tools string', () => {
      const content = [
        '---',
        'name: agent',
        'tools: ',
        '---',
        '',
        'Body.',
      ].join('\n')

      const result = registry._parseFrontmatter(content)

      expect(result.tools).toEqual([])
    })
  })

  describe('loadAll', () => {
    it('loads agent types from the agents directory', async () => {
      const agentsDir = path.resolve(
        __dirname,
        '../../../../agents'
      )
      const registry = new AgentTypeRegistry(agentsDir)
      await registry.loadAll()

      // The agents directory should have at least the reviewer agents
      expect(registry.agents.size).toBeGreaterThanOrEqual(3)
      expect(registry.get('content-reviewer')).toBeDefined()
      expect(registry.get('experiment-reviewer')).toBeDefined()
      expect(registry.get('quality-checker')).toBeDefined()
    })

    it('handles missing directory gracefully', async () => {
      const registry = new AgentTypeRegistry('/nonexistent/path')
      await registry.loadAll()

      expect(registry.agents.size).toBe(0)
    })
  })

  describe('get', () => {
    it('returns undefined for unknown agent', () => {
      const registry = new AgentTypeRegistry()
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('getAll', () => {
    it('returns metadata without body', async () => {
      const agentsDir = path.resolve(
        __dirname,
        '../../../../agents'
      )
      const registry = new AgentTypeRegistry(agentsDir)
      await registry.loadAll()

      const all = registry.getAll()
      expect(all.length).toBeGreaterThanOrEqual(3)

      for (const entry of all) {
        expect(entry).toHaveProperty('name')
        expect(entry).toHaveProperty('description')
        expect(entry).toHaveProperty('tools')
        expect(entry).toHaveProperty('maxTurns')
        expect(entry).not.toHaveProperty('body')
      }
    })
  })

  describe('loaded agent content', () => {
    it('content-reviewer has correct tools and body', async () => {
      const agentsDir = path.resolve(
        __dirname,
        '../../../../agents'
      )
      const registry = new AgentTypeRegistry(agentsDir)
      await registry.loadAll()

      const agent = registry.get('content-reviewer')
      expect(agent).toBeDefined()
      expect(agent.tools).toEqual(['read_document', 'list_files', 'search_project'])
      expect(agent.maxTurns).toBe(3)
      expect(agent.body).toContain('Content Reviewer')
      expect(agent.body).toContain('Novelty & Contribution')
    })
  })
})
