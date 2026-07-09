import { describe, expect, it } from 'vitest'

const { getAgentTeamRuntimeStatus } = await import(
  '../../../../app/js/agent-team/AgentTeamRuntimeStatus.js'
)

describe('AgentTeamRuntimeStatus', () => {
  it('lists capability diagnostics without exposing hidden prompts', async () => {
    const status = await getAgentTeamRuntimeStatus()

    expect(status).toMatchObject({
      status: 'ok',
      capabilityRegistry: {
        loaded: expect.any(Number),
        skipped: expect.any(Array),
      },
    })
    expect(status.capabilities.map(capability => capability.name)).toContain(
      'compile-fixer'
    )
    expect(status.capabilities.find(capability => capability.name === 'compile-fixer')).toMatchObject({
      role: 'handoff-specialist',
      promptRef: {
        kind: 'builtin-agent-prompt',
      },
    })
    expect(JSON.stringify(status)).not.toContain('You are a LaTeX compile repair specialist')
    expect(JSON.stringify(status)).not.toContain('# Role')
  })
})
