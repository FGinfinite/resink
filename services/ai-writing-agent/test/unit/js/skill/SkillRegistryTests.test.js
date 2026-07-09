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
  realpath: vi.fn(async p => p),
}))

const { readdir, readFile, realpath } = await import('node:fs/promises')
const { SkillRegistry, SkillPackageRegistry } = await import(
  '../../../../app/js/skill/SkillRegistry.js'
)

describe('SkillRegistry', () => {
  let registry

  beforeEach(() => {
    vi.clearAllMocks()
    registry = new SkillRegistry('/fake/skills')
  })

  describe('loadAll', () => {
    it('loads package metadata from skill directories only', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [
            { name: 'polish', isDirectory: () => true, isFile: () => false },
            { name: 'condense', isDirectory: () => true, isFile: () => false },
          ]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath.endsWith('/polish/SKILL.md')) {
          return '---\nname: polish\ndescription: Polish text\ntriggerHint: when user asks to polish\n---\nPolish instructions here'
        }
        if (filePath.endsWith('/condense/SKILL.md')) {
          return '---\nname: condense\ndescription: Condense text\ntriggerHint: when user asks to condense\n---\nCondense instructions here'
        }
        return ''
      })

      await registry.loadAll()

      expect(registry.skills.size).toBe(2)
      expect(registry.get('polish')).toBeDefined()
      expect(registry.get('condense')).toBeDefined()
    })

    it('does not load legacy flat markdown files as product paths', async () => {
      readdir.mockResolvedValue([
        { name: 'polish.md', isDirectory: () => false, isFile: () => true },
        { name: 'readme.txt', isDirectory: () => false, isFile: () => true },
        { name: 'condense', isDirectory: () => true, isFile: () => false },
      ])
      readFile.mockResolvedValue(
        '---\nname: condense\ndescription: Condense\ntriggerHint: condense\n---\nBody'
      )

      await registry.loadAll()

      expect(registry.skills.size).toBe(1)
      expect(registry.get('condense')).toBeDefined()
      expect(registry.get('polish')).toBeUndefined()
      expect(readFile).toHaveBeenCalledWith('/fake/skills/condense/SKILL.md', 'utf-8')
    })

    it('skips packages whose frontmatter name does not match the directory', async () => {
      readdir.mockResolvedValue([
        { name: 'polish', isDirectory: () => true, isFile: () => false },
      ])
      readFile.mockResolvedValue(
        '---\nname: different\ndescription: No match\ntriggerHint: test\n---\nBody'
      )

      await registry.loadAll()

      expect(registry.skills.size).toBe(0)
    })

    it('skips package directories that are not lowercase hyphenated names', async () => {
      readdir.mockResolvedValue([
        { name: 'Polish', isDirectory: () => true, isFile: () => false },
        { name: 'bad_name', isDirectory: () => true, isFile: () => false },
        { name: 'good-skill', isDirectory: () => true, isFile: () => false },
      ])
      readFile.mockResolvedValue(
        '---\nname: good-skill\ndescription: Good\ntriggerHint: test\n---\nBody'
      )

      await registry.loadAll()

      expect(registry.skills.size).toBe(1)
      expect(registry.get('good-skill')).toBeDefined()
      expect(readFile).toHaveBeenCalledWith('/fake/skills/good-skill/SKILL.md', 'utf-8')
      expect(readFile).not.toHaveBeenCalledWith('/fake/skills/Polish/SKILL.md', 'utf-8')
      expect(readFile).not.toHaveBeenCalledWith('/fake/skills/bad_name/SKILL.md', 'utf-8')
    })

    it('skips packages that resolve outside the skills directory', async () => {
      readdir.mockResolvedValue([
        { name: 'escape', isDirectory: () => true, isFile: () => false },
      ])
      realpath.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') return '/fake/skills'
        if (filePath === '/fake/skills/escape') return '/tmp/escape'
        return filePath
      })

      await registry.loadAll()

      expect(registry.skills.size).toBe(0)
      expect(readFile).not.toHaveBeenCalled()
    })

    it('skips files without name in frontmatter', async () => {
      readdir.mockResolvedValue([
        { name: 'broken', isDirectory: () => true, isFile: () => false },
      ])
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
      readdir.mockResolvedValue([
        { name: 'good', isDirectory: () => true, isFile: () => false },
        { name: 'bad', isDirectory: () => true, isFile: () => false },
      ])
      readFile.mockImplementation(async filePath => {
        if (filePath.endsWith('/bad/SKILL.md')) {
          throw new Error('read error')
        }
        return '---\nname: good\ndescription: Good skill\ntriggerHint: test\n---\nGood body'
      })

      await registry.loadAll()

      expect(registry.skills.size).toBe(1)
      expect(registry.get('good')).toBeDefined()
    })

    it('loads skill instructions while reporting invalid optional dependency metadata', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'bad-meta', isDirectory: () => true, isFile: () => false }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath === '/fake/skills/bad-meta/SKILL.md') {
          return '---\nname: bad-meta\ndescription: Bad optional meta\ntriggerHint: bad meta\n---\nInstructions'
        }
        if (filePath === '/fake/skills/bad-meta/skill.json') {
          return '{bad json'
        }
        return ''
      })

      await registry.loadAll()

      const skill = registry.get('bad-meta')
      expect(skill).toBeDefined()
      expect(skill.python).toMatchObject({
        required: true,
        status: 'missing',
        policyFindings: [
          expect.objectContaining({ code: 'INVALID_SKILL_JSON', severity: 'high' }),
        ],
      })
    })

    it('returns this for chaining', async () => {
      readdir.mockResolvedValue([])
      const result = await registry.loadAll()
      expect(result).toBe(registry)
    })
  })

  describe('getAll', () => {
    it('returns summary list without instructions', async () => {
      readdir.mockResolvedValue([
        { name: 'test-skill', isDirectory: () => true, isFile: () => false },
      ])
      readFile.mockResolvedValue(
        '---\nname: test-skill\ndescription: Test skill\ntriggerHint: test hint\n---\nBody content'
      )

      await registry.loadAll()

      const all = registry.getAll()
      expect(all).toHaveLength(1)
      expect(all[0]).toEqual({
        name: 'test-skill',
        description: 'Test skill',
        triggerHint: 'test hint',
      })
      expect(all[0].instructions).toBeUndefined()
    })

    it('returns empty array when no skills loaded', () => {
      expect(registry.getAll()).toEqual([])
    })
  })

  describe('get', () => {
    it('returns full structured package metadata', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        if (filePath === '/fake/skills/my-skill/references') {
          return [{ name: 'guide.md', isDirectory: () => false, isFile: () => true }]
        }
        if (filePath === '/fake/skills/my-skill/scripts') {
          return [{ name: 'helper.py', isDirectory: () => false, isFile: () => true }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath.endsWith('/my-skill/skill.json')) {
          return JSON.stringify({
            runtime: {
              python: {
                environment: 'skill',
                pythonVersion: '3.12',
                dependencies: ['pandas==2.2.3'],
              },
            },
          })
        }
        if (filePath.endsWith('/my-skill/scripts/helper.py')) return 'print("ok")\n'
        return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
      })

      await registry.loadAll()

      const skill = registry.get('my-skill')
      expect(skill).toEqual({
        name: 'my-skill',
        description: 'My skill',
        triggerHint: 'hint',
        instructions: 'Detailed body',
        body: 'Detailed body',
        references: [
          {
            name: 'guide.md',
            relativePath: 'references/guide.md',
          },
        ],
        scripts: [
          {
            name: 'helper.py',
            relativePath: 'scripts/helper.py',
            runtime: 'python3',
          },
        ],
        python: expect.objectContaining({
          required: true,
          skillName: 'my-skill',
          status: 'missing',
          packages: [
            expect.objectContaining({ name: 'pandas', specifier: '==2.2.3' }),
          ],
        }),
        agentCapabilities: [],
        agentCapabilityDiagnostics: {
          loaded: 0,
          skipped: [],
        },
        provenance: {
          source: 'local-package',
          packageName: 'my-skill',
          skillFile: 'SKILL.md',
        },
      })
    })

    it('loads valid skill-provided agent capabilities from skill.json', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        if (filePath === '/fake/skills/my-skill/references') {
          return [{ name: 'agent.md', isDirectory: () => false, isFile: () => true }]
        }
        if (filePath === '/fake/skills/my-skill/scripts') {
          return [{ name: 'helper.py', isDirectory: () => false, isFile: () => true }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath.endsWith('/my-skill/skill.json')) {
          return JSON.stringify({
            agentCapabilities: [
              {
                name: 'my-skill.reviewer',
                version: '1.0.0',
                description: 'Review with my skill',
                role: 'worker',
                promptRef: {
                  kind: 'skill-reference',
                  ref: 'references/agent.md',
                },
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
                defaultPolicy: {
                  tools: ['read_document', 'run_skill_script'],
                  fileGlobs: ['**/*.tex'],
                  writeGlobs: [],
                  network: 'deny',
                  pythonEnvironments: ['approved-snapshot'],
                  modelTiers: ['standard'],
                  maxDepth: 0,
                  maxToolCalls: 4,
                },
                contextPolicy: {
                  includeProjectInstructions: true,
                },
                scripts: ['helper.py'],
              },
            ],
          })
        }
        if (filePath.endsWith('/my-skill/scripts/helper.py')) return 'print("ok")\n'
        return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
      })

      await registry.loadAll()

      expect(registry.get('my-skill').agentCapabilities).toEqual([
        expect.objectContaining({
          name: 'my-skill.reviewer',
          version: '1.0.0',
          description: 'Review with my skill',
          role: 'worker',
          promptRef: {
            kind: 'skill-reference',
            skillName: 'my-skill',
            ref: 'references/agent.md',
          },
          defaultPolicy: expect.objectContaining({
            tools: ['read_document', 'run_skill_script'],
            pythonEnvironments: ['approved-snapshot'],
          }),
          contextPolicy: { includeProjectInstructions: true },
          provenance: {
            source: 'skill-package',
            skillName: 'my-skill',
            relativePath: 'skill.json',
          },
        }),
      ])
    })

    it('skips unsafe skill-provided agent capabilities without dropping the skill', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath.endsWith('/my-skill/skill.json')) {
          return JSON.stringify({
            agentCapabilities: [
              {
                name: 'other-skill.escape',
                version: '1.0.0',
                description: 'Wrong namespace',
                role: 'worker',
                promptRef: { kind: 'skill-reference', ref: 'references/agent.md' },
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
              },
              {
                name: 'my-skill.installer',
                version: '1.0.0',
                description: 'Tries to install packages',
                role: 'worker',
                promptRef: { kind: 'skill-reference', ref: '../agent.md' },
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
                defaultPolicy: {
                  tools: ['run_command'],
                  network: 'allow',
                  pythonEnvironments: ['*'],
                  allowSpawn: true,
                },
              },
            ],
          })
        }
        return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
      })

      await registry.loadAll()

      const skill = registry.get('my-skill')
      expect(skill).toBeDefined()
      expect(skill.agentCapabilities).toEqual([])
      expect(skill.agentCapabilityDiagnostics.skipped).toEqual([
        expect.objectContaining({
          name: 'other-skill.escape',
          reason: 'invalid-skill-capability-name',
        }),
        expect.objectContaining({
          name: 'my-skill.installer',
          reason: 'invalid-skill-capability-prompt-ref',
        }),
      ])
    })

    it('returns undefined for unknown skill', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })
  })


  describe('readReference', () => {
    it('loads only declared reference files by relative path', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        if (filePath === '/fake/skills/my-skill/references') {
          return [{ name: 'guide.md', isDirectory: () => false, isFile: () => true }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath === '/fake/skills/my-skill/SKILL.md') {
          return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
        }
        if (filePath === '/fake/skills/my-skill/references/guide.md') {
          return 'Reference body'
        }
        return ''
      })

      await registry.loadAll()
      const reference = await registry.readReference('my-skill', 'references/guide.md')

      expect(reference).toEqual({
        skillName: 'my-skill',
        path: 'references/guide.md',
        name: 'guide.md',
        content: 'Reference body',
        provenance: {
          source: 'local-package',
          packageName: 'my-skill',
          relativePath: 'references/guide.md',
        },
      })
    })

    it('does not read undeclared, absolute, or escaping reference paths', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        if (filePath === '/fake/skills/my-skill/references') {
          return [{ name: 'guide.md', isDirectory: () => false, isFile: () => true }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath === '/fake/skills/my-skill/SKILL.md') {
          return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
        }
        if (filePath === '/fake/skills/my-skill/references/guide.md') {
          return 'Reference body'
        }
        throw new Error(`unexpected read: ${filePath}`)
      })

      await registry.loadAll()

      expect(await registry.readReference('my-skill', '../secret.md')).toBeUndefined()
      expect(await registry.readReference('my-skill', '/etc/passwd')).toBeUndefined()
      expect(await registry.readReference('my-skill', 'references/missing.md')).toBeUndefined()
      expect(readFile).not.toHaveBeenCalledWith('/fake/skills/my-skill/references/missing.md', 'utf-8')
      expect(readFile).not.toHaveBeenCalledWith('/fake/skills/my-skill/../secret.md', 'utf-8')
      expect(readFile).not.toHaveBeenCalledWith('/etc/passwd', 'utf-8')
    })
  })


  describe('readScript', () => {
    it('loads only declared scripts by file name with safe provenance', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        if (filePath === '/fake/skills/my-skill/scripts') {
          return [{ name: 'helper.py', isDirectory: () => false, isFile: () => true }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath === '/fake/skills/my-skill/SKILL.md') {
          return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
        }
        if (filePath === '/fake/skills/my-skill/scripts/helper.py') {
          return 'print("ok")\n'
        }
        return ''
      })

      await registry.loadAll()
      const script = await registry.readScript('my-skill', 'helper.py')

      expect(script).toEqual({
        skillName: 'my-skill',
        name: 'helper.py',
        relativePath: 'scripts/helper.py',
        runtime: 'python3',
        python: expect.objectContaining({
          required: false,
          status: 'none',
        }),
        content: 'print("ok")\n',
        provenance: {
          source: 'local-package',
          packageName: 'my-skill',
          relativePath: 'scripts/helper.py',
        },
      })
    })

    it('does not read undeclared or escaping script names', async () => {
      readdir.mockImplementation(async filePath => {
        if (filePath === '/fake/skills') {
          return [{ name: 'my-skill', isDirectory: () => true, isFile: () => false }]
        }
        if (filePath === '/fake/skills/my-skill/scripts') {
          return [{ name: 'helper.py', isDirectory: () => false, isFile: () => true }]
        }
        return []
      })
      readFile.mockImplementation(async filePath => {
        if (filePath === '/fake/skills/my-skill/SKILL.md') {
          return '---\nname: my-skill\ndescription: My skill\ntriggerHint: hint\n---\nDetailed body'
        }
        if (filePath === '/fake/skills/my-skill/scripts/helper.py') {
          return 'print("ok")\n'
        }
        throw new Error(`unexpected read: ${filePath}`)
      })

      await registry.loadAll()

      expect(await registry.readScript('my-skill', '../secret.py')).toBeUndefined()
      expect(await registry.readScript('my-skill', 'missing.py')).toBeUndefined()
      expect(readFile).not.toHaveBeenCalledWith('/fake/skills/my-skill/scripts/missing.py', 'utf-8')
      expect(readFile).not.toHaveBeenCalledWith('/fake/skills/my-skill/scripts/../secret.py', 'utf-8')
    })
  })

  describe('buildSkillListDescription', () => {
    it('returns formatted skill list', async () => {
      readdir.mockResolvedValue([
        { name: 'alpha', isDirectory: () => true, isFile: () => false },
        { name: 'beta', isDirectory: () => true, isFile: () => false },
      ])
      readFile.mockImplementation(async filePath => {
        if (filePath.endsWith('/alpha/SKILL.md')) {
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

  it('exports SkillPackageRegistry as the primary implementation', () => {
    expect(SkillRegistry).toBe(SkillPackageRegistry)
  })
})
