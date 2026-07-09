import { describe, expect, it, vi } from 'vitest'

const { AgentCapabilityPromptLoader } = await import(
  '../../../../app/js/agent-team/AgentCapabilityPromptLoader.js'
)

describe('AgentCapabilityPromptLoader', () => {
  it('loads built-in capability prompt bodies from structured capability metadata', async () => {
    const loader = new AgentCapabilityPromptLoader()

    const prompt = await loader.loadPrompt({
      promptRef: { kind: 'builtin-agent-prompt', prompt: 'Built-in prompt' },
    })

    expect(prompt).toBe('Built-in prompt')
  })

  it('loads prompt bodies from activated skill instructions and references', async () => {
    const skillRegistry = {
      get: vi.fn(name => {
        if (name !== 'polish') return null
        return { instructions: 'Skill instructions' }
      }),
      readReference: vi.fn(async (skillName, ref) => ({
        skillName,
        path: ref,
        content: 'Reference instructions',
      })),
    }
    const loader = new AgentCapabilityPromptLoader({ skillRegistry })

    const skillPrompt = await loader.loadPrompt({
      promptRef: { kind: 'skill', skillName: 'polish', ref: 'SKILL.md' },
    })
    expect(skillPrompt).toBe('Skill instructions')

    const referencePrompt = await loader.loadPrompt({
      promptRef: {
        kind: 'skill-reference',
        skillName: 'polish',
        ref: 'references/agent.md',
      },
    })
    expect(referencePrompt).toBe('Reference instructions')
    expect(skillRegistry.readReference).toHaveBeenCalledWith(
      'polish',
      'references/agent.md'
    )
  })

  it('rejects missing or unsafe skill prompt refs', async () => {
    const loader = new AgentCapabilityPromptLoader({
      skillRegistry: {
        get: vi.fn(() => null),
        readReference: vi.fn(async () => null),
      },
    })

    let missingError
    try {
      await loader.loadPrompt({
        promptRef: { kind: 'skill', skillName: 'missing', ref: 'SKILL.md' },
      })
    } catch (error) {
      missingError = error
    }
    expect(missingError).toMatchObject({
      message: 'Unknown skill capability promptRef',
    })

    let unsafeError
    try {
      await loader.loadPrompt({
        promptRef: {
          kind: 'skill-reference',
          skillName: 'polish',
          ref: '../secret.md',
        },
      })
    } catch (error) {
      unsafeError = error
    }
    expect(unsafeError).toMatchObject({
      message: 'Unsafe skill capability promptRef',
    })
  })
})
