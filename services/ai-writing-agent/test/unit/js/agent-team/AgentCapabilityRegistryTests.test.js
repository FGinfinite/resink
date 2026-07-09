import { describe, expect, it, vi } from 'vitest'

const { AgentCapabilityRegistry } = await import(
  '../../../../app/js/agent-team/AgentCapabilityRegistry.js'
)
const { BUILT_IN_AGENT_CAPABILITIES } = await import(
  '../../../../app/js/agent-team/capabilities/builtInCapabilities.js'
)

describe('AgentCapabilityRegistry', () => {
  it('loads built-in capabilities as structured metadata without exposing prompt bodies', async () => {
    const registry = new AgentCapabilityRegistry({
      definitions: BUILT_IN_AGENT_CAPABILITIES,
    })

    const diagnostics = await registry.loadAll()
    const metadata = registry.listMetadata()

    expect(diagnostics.loaded).toBeGreaterThanOrEqual(7)
    expect(metadata.map(capability => capability.name)).toEqual(
      expect.arrayContaining([
        'content-reviewer',
        'experiment-reviewer',
        'quality-checker',
        'document-auditor',
        'citation-assistant',
        'compile-fixer',
        'writing-editor',
      ])
    )

    const compileFixerMetadata = metadata.find(
      capability => capability.name === 'compile-fixer'
    )
    expect(compileFixerMetadata).toMatchObject({
      name: 'compile-fixer',
      role: 'handoff-specialist',
      version: '1.0.0',
      defaultToolsets: expect.arrayContaining(['project-read', 'compile']),
      promptRef: {
        kind: 'builtin-agent-prompt',
      },
    })
    expect(JSON.stringify(compileFixerMetadata)).not.toContain('# Role')
    expect(registry.get('compile-fixer').promptRef).toMatchObject({
      kind: 'builtin-agent-prompt',
      prompt: expect.stringContaining('LaTeX compile repair specialist'),
    })
  })

  it('gives deep review reviewers enough tool budget for full-paper review', async () => {
    const registry = new AgentCapabilityRegistry({
      definitions: BUILT_IN_AGENT_CAPABILITIES,
    })

    await registry.loadAll()

    for (const name of ['content-reviewer', 'experiment-reviewer', 'quality-checker']) {
      expect(registry.get(name).defaultPolicy.maxToolCalls).toBeGreaterThanOrEqual(24)
    }
  })

  it('skips invalid capabilities with safe diagnostics', async () => {
    const warn = vi.fn()
    const registry = new AgentCapabilityRegistry({
      logger: { warn },
      definitions: [
        {
          name: 'valid-worker',
          version: '1.0.0',
          description: 'Valid worker',
          role: 'worker',
          promptRef: { kind: 'inline-test-ref', ref: 'valid' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          defaultPolicy: { tools: ['read_document'] },
          contextPolicy: { includeParentHistory: false },
        },
        {
          name: '../escape',
          version: '1.0.0',
          description: 'Invalid name',
          role: 'worker',
          promptRef: { kind: 'inline-test-ref', ref: 'bad' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        },
        {
          name: 'bad-role',
          version: '1.0.0',
          description: 'Invalid role',
          role: 'superuser',
          promptRef: { kind: 'inline-test-ref', ref: 'bad' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        },
      ],
    })

    const diagnostics = await registry.loadAll()

    expect(diagnostics.loaded).toBe(1)
    expect(diagnostics.skipped).toHaveLength(2)
    expect(registry.get('valid-worker')).toBeDefined()
    expect(registry.get('../escape')).toBeUndefined()
    expect(registry.get('bad-role')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('loads skill capabilities only for activated skills and skips collisions', async () => {
    const warn = vi.fn()
    const skillRegistry = {
      get: vi.fn(name => {
        if (name === 'polish') {
          return {
            agentCapabilities: [
              {
                name: 'polish.reviewer',
                version: '1.0.0',
                description: 'Polish reviewer',
                role: 'worker',
                promptRef: {
                  kind: 'skill-reference',
                  skillName: 'polish',
                  ref: 'references/agent.md',
                },
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
                defaultPolicy: { tools: ['read_document'] },
              },
              {
                name: 'content-reviewer',
                version: '1.0.0',
                description: 'Collision',
                role: 'worker',
                promptRef: {
                  kind: 'skill-reference',
                  skillName: 'polish',
                  ref: 'references/agent.md',
                },
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
              },
            ],
          }
        }
        if (name === 'inactive') {
          return {
            agentCapabilities: [
              {
                name: 'inactive.reviewer',
                version: '1.0.0',
                description: 'Inactive reviewer',
                role: 'worker',
                promptRef: {
                  kind: 'skill-reference',
                  skillName: 'inactive',
                  ref: 'references/agent.md',
                },
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
              },
            ],
          }
        }
        return null
      }),
    }
    const registry = new AgentCapabilityRegistry({
      logger: { warn },
      definitions: [
        {
          name: 'content-reviewer',
          version: '1.0.0',
          description: 'Built-in reviewer',
          role: 'worker',
          promptRef: { kind: 'builtin-agent-prompt', prompt: 'Prompt' },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
        },
      ],
      skillRegistry,
      activatedSkillNames: ['polish'],
    })

    const diagnostics = await registry.loadAll()

    expect(registry.get('polish.reviewer')).toMatchObject({
      name: 'polish.reviewer',
      provenance: { source: 'skill-package', skillName: 'polish' },
    })
    expect(registry.get('inactive.reviewer')).toBeUndefined()
    expect(registry.get('content-reviewer').description).toBe('Built-in reviewer')
    expect(diagnostics.loaded).toBe(2)
    expect(diagnostics.skipped).toEqual([
      expect.objectContaining({
        name: 'content-reviewer',
        reason: 'duplicate-capability-name',
      }),
    ])
  })
})
