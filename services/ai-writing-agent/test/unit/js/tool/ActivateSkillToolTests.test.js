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

const { ActivateSkillTool } = await import(
  '../../../../app/js/tool/activate_skill.js'
)

describe('ActivateSkillTool', () => {
  let tool
  let mockSkillRegistry

  beforeEach(() => {
    mockSkillRegistry = {
      buildSkillListDescription: vi.fn().mockReturnValue(
        '- polish: Polish text (trigger: when polish)\n- condense: Condense text (trigger: when condense)'
      ),
      getAll: vi.fn().mockReturnValue([
        { name: 'polish', description: 'Polish text', triggerHint: 'when polish' },
        { name: 'condense', description: 'Condense text', triggerHint: 'when condense' },
      ]),
      get: vi.fn(),
    }

    tool = new ActivateSkillTool(mockSkillRegistry)
  })

  describe('constructor', () => {
    it('sets name to activate_skill', () => {
      expect(tool.name).toBe('activate_skill')
    })

    it('includes skill list in description', () => {
      expect(tool.description).toContain('polish')
      expect(tool.description).toContain('condense')
    })
  })

  describe('execute', () => {
    it('returns skill body on success', async () => {
      mockSkillRegistry.get.mockReturnValue({
        name: 'polish',
        description: 'Polish text',
        triggerHint: 'when polish',
        instructions: '# Polish Instructions\n\nDetailed instructions here.',
        references: [
          {
            name: 'style.md',
            relativePath: 'references/style.md',
          },
        ],
        scripts: [
          {
            name: 'check.js',
            relativePath: 'scripts/check.js',
            runtime: 'node',
          },
        ],
        provenance: {
          source: 'local-package',
          packageName: 'polish',
          skillFile: 'SKILL.md',
        },
        python: {
          required: true,
          status: 'missing',
          packages: [{ name: 'pandas', specifier: '==2.2.3' }],
        },
        agentCapabilities: [
          {
            name: 'polish.reviewer',
            version: '1.0.0',
            description: 'Polish reviewer',
          },
        ],
        events: [{
          type: 'skill.activated',
          skillName: 'polish',
          references: [
            {
              name: 'style.md',
              relativePath: 'references/style.md',
            },
          ],
          scripts: [
            {
              name: 'check.js',
              relativePath: 'scripts/check.js',
              runtime: 'node',
            },
          ],
          provenance: {
            source: 'local-package',
            packageName: 'polish',
            skillFile: 'SKILL.md',
          },
          python: {
            required: true,
            status: 'missing',
            packages: [{ name: 'pandas', specifier: '==2.2.3' }],
          },
        }],
      })

      const result = await tool.execute({ name: 'polish' }, {})

      expect(result.success).toBe(true)
      expect(result.output).toContain('# Polish Instructions\n\nDetailed instructions here.')
      expect(result.output).toContain('Available skill assets:')
      expect(result.output).toContain('- references/style.md')
      expect(result.output).toContain('- run_skill_script skill="polish" script="check.js"')
      expect(result.output).toContain('Python environment: missing')
      expect(result.output).toContain('pandas==2.2.3')
      expect(result.output).toContain('- start_agent_task capabilityName="polish.reviewer"')
      expect(result.data).toEqual({
        skillName: 'polish',
        instructions: '# Polish Instructions\n\nDetailed instructions here.',
        references: [
          {
            name: 'style.md',
            relativePath: 'references/style.md',
          },
        ],
        scripts: [
          {
            name: 'check.js',
            relativePath: 'scripts/check.js',
            runtime: 'node',
          },
        ],
        provenance: {
          source: 'local-package',
          packageName: 'polish',
          skillFile: 'SKILL.md',
        },
        python: {
          required: true,
          status: 'missing',
          packages: [{ name: 'pandas', specifier: '==2.2.3' }],
        },
        agentCapabilities: [
          {
            name: 'polish.reviewer',
            version: '1.0.0',
            description: 'Polish reviewer',
          },
        ],
        events: [{
          type: 'skill.activated',
          skillName: 'polish',
          references: [
            {
              name: 'style.md',
              relativePath: 'references/style.md',
            },
          ],
          scripts: [
            {
              name: 'check.js',
              relativePath: 'scripts/check.js',
              runtime: 'node',
            },
          ],
          provenance: {
            source: 'local-package',
            packageName: 'polish',
            skillFile: 'SKILL.md',
          },
          python: {
            required: true,
            status: 'missing',
            packages: [{ name: 'pandas', specifier: '==2.2.3' }],
          },
          agentCapabilities: [
            {
              name: 'polish.reviewer',
              version: '1.0.0',
              description: 'Polish reviewer',
            },
          ],
        }],
      })
    })


    it('returns empty references and scripts arrays when package has none', async () => {
      mockSkillRegistry.get.mockReturnValue({
        name: 'condense',
        instructions: '# Condense Instructions',
      })

      const result = await tool.execute({ name: 'condense' }, {})

      expect(result.success).toBe(true)
      expect(result.output).toContain('# Condense Instructions')
      expect(result.output).toContain('Available skill assets:')
      expect(result.output).toContain('References: none')
      expect(result.output).toContain('Scripts: none')
      expect(result.output).toContain('Python environment: none')
      expect(result.data).toEqual({
        skillName: 'condense',
        instructions: '# Condense Instructions',
        references: [],
        scripts: [],
        agentCapabilities: [],
        python: { required: false, status: 'none' },
        provenance: {},
        events: [{
          type: 'skill.activated',
          skillName: 'condense',
          references: [],
          scripts: [],
          agentCapabilities: [],
          python: { required: false, status: 'none' },
          provenance: {},
        }],
      })
    })

    it('returns error for unknown skill', async () => {
      mockSkillRegistry.get.mockReturnValue(undefined)

      const result = await tool.execute({ name: 'nonexistent' }, {})

      expect(result.success).toBe(false)
      expect(result.output).toContain('Unknown skill "nonexistent"')
      expect(result.output).toContain('polish')
      expect(result.output).toContain('condense')
    })
  })

  describe('toOpenAIFormat', () => {
    it('generates correct format', () => {
      const format = tool.toOpenAIFormat()

      expect(format.type).toBe('function')
      expect(format.function.name).toBe('activate_skill')
      expect(format.function.parameters.type).toBe('object')
      expect(format.function.parameters.properties.name).toBeDefined()
      expect(format.function.parameters.required).toContain('name')
    })
  })
})
