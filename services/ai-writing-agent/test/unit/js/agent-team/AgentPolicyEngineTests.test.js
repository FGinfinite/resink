import { describe, expect, it } from 'vitest'

const { AgentPolicyEngine, AgentPolicyError } = await import(
  '../../../../app/js/agent-team/AgentPolicyEngine.js'
)

describe('AgentPolicyEngine', () => {
  it('computes a monotonic child policy from parent, capability, and workflow policy', () => {
    const engine = new AgentPolicyEngine()

    const policy = engine.computeChildPolicy({
      parentPolicy: {
        tools: ['read_document', 'search_project', 'edit_document', 'compile_latex'],
        fileGlobs: ['**/*.tex', '**/*.bib'],
        writeGlobs: ['chapters/*.tex'],
        network: 'deny',
        pythonEnvironments: ['pyenv_project'],
        modelTiers: ['standard', 'quality'],
        maxDepth: 2,
        maxParallelTasks: 4,
        maxToolCalls: 20,
        allowSpawn: true,
        allowHandoff: true,
      },
      capabilityPolicy: {
        tools: ['read_document', 'edit_document', 'run_command'],
        fileGlobs: ['main.tex', 'chapters/*.tex'],
        writeGlobs: ['main.tex', 'chapters/*.tex'],
        network: 'package-index-proxy',
        pythonEnvironments: ['pyenv_project', 'pyenv_other'],
        modelTiers: ['quality'],
        maxDepth: 5,
        maxParallelTasks: 8,
        maxToolCalls: 50,
        allowSpawn: true,
        allowHandoff: false,
      },
      workflowPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['chapters/*.tex'],
        writeGlobs: ['chapters/*.tex'],
        network: 'deny',
        modelTiers: ['quality', 'standard'],
        maxDepth: 1,
        maxParallelTasks: 2,
        maxToolCalls: 7,
      },
    })

    expect(policy).toEqual({
      tools: ['read_document', 'edit_document'],
      fileGlobs: ['chapters/*.tex'],
      writeGlobs: ['chapters/*.tex'],
      network: 'deny',
      pythonEnvironments: ['pyenv_project'],
      modelTiers: ['quality'],
      maxDepth: 1,
      maxParallelTasks: 2,
      maxToolCalls: 7,
      allowSpawn: false,
      allowHandoff: false,
    })
  })

  it('rejects child policy attempts that cannot fit inside the parent boundary', () => {
    const engine = new AgentPolicyEngine()

    expect(() => engine.computeChildPolicy({
      parentPolicy: {
        tools: ['read_document'],
        fileGlobs: ['main.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 3,
        allowSpawn: false,
        allowHandoff: false,
      },
      capabilityPolicy: {
        tools: ['edit_document'],
        fileGlobs: ['secret.tex'],
        writeGlobs: ['secret.tex'],
        network: 'allow',
        pythonEnvironments: ['pyenv_secret'],
        modelTiers: ['premium'],
        maxDepth: 1,
        maxParallelTasks: 2,
        maxToolCalls: 10,
        allowSpawn: true,
        allowHandoff: true,
      },
    })).toThrow(AgentPolicyError)
  })

  it('fails closed with clear reasons for individual escalation probes', () => {
    const engine = new AgentPolicyEngine()
    const parentPolicy = {
      tools: ['read_document', 'edit_document'],
      fileGlobs: ['main.tex'],
      writeGlobs: ['main.tex'],
      network: 'deny',
      pythonEnvironments: ['approved-python'],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 3,
      allowSpawn: false,
      allowHandoff: false,
    }

    const probes = [
      {
        name: 'child-write-escalation',
        capabilityPolicy: { tools: ['edit_document'], fileGlobs: ['main.tex'], writeGlobs: ['secret.tex'], modelTiers: ['standard'], maxToolCalls: 1 },
        failures: ['writeGlobs'],
      },
      {
        name: 'child-network-escalation',
        capabilityPolicy: { tools: ['read_document'], fileGlobs: ['main.tex'], network: 'allow', modelTiers: ['standard'], maxToolCalls: 1 },
        expectedNetwork: 'deny',
      },
      {
        name: 'child-python-env-escalation',
        capabilityPolicy: { tools: ['read_document'], fileGlobs: ['main.tex'], pythonEnvironments: ['host-python'], modelTiers: ['standard'], maxToolCalls: 1 },
        failures: ['pythonEnvironments'],
      },
      {
        name: 'child-model-tier-escalation',
        capabilityPolicy: { tools: ['read_document'], fileGlobs: ['main.tex'], modelTiers: ['premium'], maxToolCalls: 1 },
        failures: ['modelTiers'],
      },
      {
        name: 'child-spawn-escalation',
        capabilityPolicy: { tools: ['read_document'], fileGlobs: ['main.tex'], modelTiers: ['standard'], maxToolCalls: 1, allowSpawn: true, allowHandoff: true },
        expectedFlags: { allowSpawn: false, allowHandoff: false },
      },
      {
        name: 'child-file-glob-escape',
        capabilityPolicy: { tools: ['read_document'], fileGlobs: ['chapters/*.tex'], modelTiers: ['standard'], maxToolCalls: 1 },
        failures: ['fileGlobs'],
      },
    ]

    for (const probe of probes) {
      try {
        const policy = engine.computeChildPolicy({
          parentPolicy,
          capabilityPolicy: probe.capabilityPolicy,
        })
        if (probe.failures) {
          throw new Error(`${probe.name} unexpectedly produced ${JSON.stringify(policy)}`)
        }
        if (probe.expectedNetwork) expect(policy.network).toBe(probe.expectedNetwork)
        if (probe.expectedFlags) expect(policy).toMatchObject(probe.expectedFlags)
      } catch (error) {
        if (!probe.failures) throw error
        expect(error).toBeInstanceOf(AgentPolicyError)
        expect(error.info).toMatchObject({
          reason: 'empty-child-policy',
          failures: expect.arrayContaining(probe.failures),
        })
      }
    }
  })

  it('treats omitted task policy fields as inherited constraints', () => {
    const engine = new AgentPolicyEngine()

    const policy = engine.computeChildPolicy({
      parentPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 1,
        maxToolCalls: 10,
        allowSpawn: false,
        allowHandoff: false,
      },
      capabilityPolicy: {
        tools: ['read_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 8,
        allowSpawn: false,
        allowHandoff: false,
      },
      taskPolicy: {
        tools: ['read_document'],
      },
    })

    expect(policy).toMatchObject({
      tools: ['read_document'],
      fileGlobs: ['**/*.tex'],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 8,
    })
  })

  it('removes recursive and memory-write tools from child policies', () => {
    const engine = new AgentPolicyEngine()

    const policy = engine.computeChildPolicy({
      parentPolicy: {
        tools: ['read_document', 'propose_memory', 'start_agent_task'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 1,
        maxToolCalls: 8,
        allowSpawn: false,
        allowHandoff: false,
      },
      capabilityPolicy: {
        tools: ['read_document', 'propose_memory', 'start_agent_task'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 4,
        allowSpawn: false,
        allowHandoff: false,
      },
    })

    expect(policy.tools).toEqual(['read_document'])
  })

  it('requires write globs for every model-visible write tool', () => {
    const engine = new AgentPolicyEngine()
    const writeTools = [
      'edit_document',
      'delete_file',
      'sync_workspace_changes',
      'write_workspace_file',
      'bib_manage',
    ]

    for (const tool of writeTools) {
      expect(() => engine.computeChildPolicy({
        parentPolicy: {
          tools: [tool],
          fileGlobs: ['main.tex'],
          writeGlobs: [],
          network: 'deny',
          pythonEnvironments: [],
          modelTiers: ['standard'],
          maxDepth: 0,
          maxParallelTasks: 1,
          maxToolCalls: 3,
          allowSpawn: false,
          allowHandoff: false,
        },
        capabilityPolicy: {
          tools: [tool],
          fileGlobs: ['main.tex'],
          writeGlobs: [],
          network: 'deny',
          pythonEnvironments: [],
          modelTiers: ['standard'],
          maxDepth: 0,
          maxParallelTasks: 1,
          maxToolCalls: 1,
          allowSpawn: false,
          allowHandoff: false,
        },
      })).toThrow(AgentPolicyError)
    }
  })

  it('allows explicit child write globs when parent write globs are not specified', () => {
    const engine = new AgentPolicyEngine()

    const policy = engine.computeChildPolicy({
      parentPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*'],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 1,
        maxToolCalls: 10,
        allowSpawn: false,
        allowHandoff: false,
      },
      capabilityPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: ['**/*.tex'],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 4,
        allowSpawn: false,
        allowHandoff: false,
      },
    })

    expect(policy.writeGlobs).toEqual(['**/*.tex'])
  })

  it('preserves task write globs when parent and capability omit write globs', () => {
    const engine = new AgentPolicyEngine()

    const policy = engine.computeChildPolicy({
      parentPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*'],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 1,
        maxToolCalls: 10,
        allowSpawn: false,
        allowHandoff: false,
      },
      capabilityPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*.tex'],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 4,
        allowSpawn: false,
        allowHandoff: false,
      },
      taskPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: ['**/*.tex'],
      },
    })

    expect(policy.writeGlobs).toEqual(['**/*.tex'])
  })
})
