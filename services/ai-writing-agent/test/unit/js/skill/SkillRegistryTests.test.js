import { describe, it, expect, vi, beforeEach } from 'vitest'

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

// Mock fs/promises for controlled testing
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn(async (p) => p),
}))

const { readdir, readFile } = await import('node:fs/promises')
const { SkillRegistry } = await import(
  '../../../../app/js/skill/SkillRegistry.js'
)

describe('SkillRegistry', () => {
  let registry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new SkillRegistry('/fake/skills')
  })

  describe('loadAll', () => {
    it('loads skill files from the directory', async () => {
      readdir.mockResolvedValue(['polish.md', 'condense.md'])
      readFile.mockImplementation(async (filePath) => {
        if (filePath.endsWith('polish.md')) {
          return '---\nname: polish\ndescription: Polish text\ntriggerHint: when user asks to polish\n---\nPolish instructions here'
        }
        if (filePath.endsWith('condense.md')) {
          return '---\nname: condense\ndescription: Condense text\ntriggerHint: when user asks to condense\n---\nCondense instructions here'
        }
        return ''
      })

      await registry.loadAll()

      expect(registry.skills.size).toBe(2)
      expect(registry.get('polish')).toBeDefined()
      expect(registry.get('condense')).toBeDefined()
    })

    it('skips non-.md files', async () => {
      readdir.mockResolvedValue(['polish.md', 'readme.txt', 'notes.json'])
      readFile.mockResolvedValue(
        '---\nname: polish\ndescription: Polish\ntriggerHint: polish\n---\nBody'
      )

      await registry.loadAll()

      expect(registry.skills.size).toBe(1)
      expect(readFile).toHaveBeenCalledTimes(1)
    })

    it('skips files without name in frontmatter', async () => {
      readdir.mockResolvedValue(['broken.md'])
      readFile.mockResolvedValue(
        '---\ndescription: No name field\n---\nBody content'
      )

      await registry.loadAll()

      expect(registry.skills.size).toBe(0)
    })

    it('handles missing directory gracefully', async () => {
      readdir.mockRejectedValue(new Error('ENOENT'))

      await registry.loadAll()

      expect(registry.skills.size).toBe(0)
    })

    it('handles individual file read errors gracefully', async () => {
      readdir.mockResolvedValue(['good.md', 'bad.md'])
      readFile.mockImplementation(async (filePath) => {
        if (filePath.endsWith('bad.md')) {
          throw new Error('read error')
        }
        return '---\nname: good\ndescription: Good skill\ntriggerHint: test\n---\nGood body'
      })

      await registry.loadAll()

      expect(registry.skills.size).toBe(1)
      expect(registry.get('good')).toBeDefined()
    })

    it('returns this for chaining', async () => {
      readdir.mockResolvedValue([])
      const result = await registry.loadAll()
      expect(result).toBe(registry)
    })
  })

  describe('getAll', () => {
    it('returns summary list without body', async () => {
      readdir.mockResolvedValue(['test.md'])
      readFile.mockResolvedValue(
        '---\nname: test\ndescription: Test skill\ntriggerHint: test hint\n---\nBody content'
      )

      await registry.loadAll()

      const all = registry.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual({
        name: 'test',
        description: 'Test skill',
        triggerHint: 'test hint',
      })
      expect(all[0].body).toBeUndefined()
    })

    it('returns empty array when no skills loaded', () => {
      expect(registry.getAll()).toEqual([])
    })
  })

  describe('get', () => {
    it('returns full skill with body', async () => {
      readdir.mockResolvedValue(['skill.md'])
      readFile.mockResolvedValue(
        '---\nname: myskill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
      )

      await registry.loadAll()

      const skill = registry.get('myskill')
      expect(skill).toBeDefined()
      expect(skill.name).toBe('myskill')
      expect(skill.description).toBe('My skill')
      expect(skill.triggerHint).toBe('hint')
      expect(skill.body).toBe('Detailed body')
    })

    it('returns undefined for unknown skill', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })

  describe('buildSkillListDescription', () => {
    it('returns formatted skill list', async () => {
      readdir.mockResolvedValue(['a.md', 'b.md'])
      readFile.mockImplementation(async (filePath) => {
        if (filePath.endsWith('a.md')) {
          return '---\nname: alpha\ndescription: Alpha skill\ntriggerHint: alpha hint\n---\nAlpha body'
        }
        return '---\nname: beta\ndescription: Beta skill\ntriggerHint: beta hint\n---\nBeta body'
      })

      await registry.loadAll()

      const desc = registry.buildSkillListDescription()
      expect(desc).toContain('- alpha: Alpha skill (trigger: alpha hint)')
      expect(desc).toContain('- beta: Beta skill (trigger: beta hint)')
    })

    it('returns empty string when no skills', () => {
      expect(registry.buildSkillListDescription()).toBe('')
    })
  })

  describe('_parseFrontmatter', () => {
    it('parses frontmatter and body', () => {
      const content = '---\nname: test\ndescription: Test\n---\nBody here'
      const result = registry._parseFrontmatter(content)

      expect(result.meta.name).toBe('test')
      expect(result.meta.description).toBe('Test')
      expect(result.body).toBe('Body here')
    })

    it('handles content without frontmatter', () => {
      const content = 'Just body content'
      const result = registry._parseFrontmatter(content)

      expect(result.meta).toEqual({})
      expect(result.body).toBe('Just body content')
    })

    it('handles values with colons', () => {
      const content = '---\nname: test\ndescription: This: has colons: here\n---\nBody'
      const result = registry._parseFrontmatter(content)

      expect(result.meta.description).toBe('This: has colons: here')
    })

    it('handles empty frontmatter', () => {
      const content = '---\n\n---\nBody'
      const result = registry._parseFrontmatter(content)

      expect(result.meta).toEqual({})
      expect(result.body).toBe('Body')
    })
  })
})
