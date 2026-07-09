import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const { ReadSkillReferenceTool } = await import(
  '../../../../app/js/tool/read_skill_reference.js'
)

describe('ReadSkillReferenceTool', () => {
  let registry

  beforeEach(() => {
    registry = {
      readReference: vi.fn(),
    }
  })

  it('returns declared reference content with safe provenance and event', async () => {
    registry.readReference.mockResolvedValue({
      skillName: 'polish',
      path: 'references/style.md',
      name: 'style.md',
      content: 'Style guide body',
      provenance: {
        source: 'local-package',
        packageName: 'polish',
        relativePath: 'references/style.md',
      },
    })
    const tool = new ReadSkillReferenceTool(registry)

    const result = await tool.execute({ skill: 'polish', path: 'references/style.md' })

    expect(result.success).toBe(true)
    expect(result.output).toBe('Style guide body')
    expect(result.data).toEqual({
      skillName: 'polish',
      path: 'references/style.md',
      name: 'style.md',
      content: 'Style guide body',
      provenance: {
        source: 'local-package',
        packageName: 'polish',
        relativePath: 'references/style.md',
      },
      events: [{
        type: 'skill.reference.loaded',
        skillName: 'polish',
        path: 'references/style.md',
        provenance: {
          source: 'local-package',
          packageName: 'polish',
          relativePath: 'references/style.md',
        },
      }],
    })
  })

  it('rejects unknown or undeclared references', async () => {
    registry.readReference.mockResolvedValue(undefined)
    const tool = new ReadSkillReferenceTool(registry)

    const result = await tool.execute({ skill: 'polish', path: '../secret' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown skill reference')
  })
})
