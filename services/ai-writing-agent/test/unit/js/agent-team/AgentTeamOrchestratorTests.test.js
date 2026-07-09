import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const { AgentTeamOrchestrator } = await import(
  '../../../../app/js/agent-team/AgentTeamOrchestrator.js'
)

function createStore() {
  const teams = []
  const tasks = []
  const contextPacks = []
  const results = []
  const events = []
  return {
    teams,
    tasks,
    contextPacks,
    results,
    events,
    async createTeamRun(doc) {
      const team = {
        _id: new ObjectId(),
        status: 'queued',
        ...doc,
      }
      teams.push(team)
      return team
    },
    async createTaskFromSpec({ teamId, rootSessionId, spec }) {
      const task = {
        _id: new ObjectId(),
        teamId,
        rootSessionId,
        status: 'queued',
        agentName: spec.capabilityName,
        agentVersion: spec.capabilityVersion,
        mode: spec.mode,
        objective: spec.objective,
        policy: spec.policy,
        contextPackId: null,
      }
      tasks.push(task)
      return task
    },
    async createContextPack(doc) {
      const contextPack = { _id: new ObjectId(), ...doc }
      contextPacks.push(contextPack)
      return contextPack
    },
    async attachContextPack({ taskId, contextPackId }) {
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      task.contextPackId = contextPackId
    },
    async markTaskRunning({ taskId, childSessionId, toolCallId }) {
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, { status: 'running', childSessionId, toolCallId })
    },
    async completeTask({ taskId, teamId, result, usage }) {
      const resultDoc = { _id: new ObjectId(), taskId, teamId, ...result, usage }
      results.push(resultDoc)
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, { status: 'completed', resultId: resultDoc._id })
      return resultDoc
    },
    async failTask({ taskId, teamId, error, status = 'failed', result = {}, usage = {} }) {
      const resultDoc = {
        _id: new ObjectId(),
        taskId,
        teamId,
        status,
        summary: result.summary || String(error?.message || error || 'failed'),
        findings: result.findings || [],
        proposedEdits: result.proposedEdits || [],
        artifacts: result.artifacts || [],
        evidenceRefs: result.evidenceRefs || [],
        confidence: result.confidence ?? null,
        usage,
      }
      results.push(resultDoc)
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, {
        status,
        resultId: resultDoc._id,
        error: { message: resultDoc.summary },
      })
      return resultDoc
    },
    async completeTeamRun({ teamId, status }) {
      const team = teams.find(item => item._id.toString() === teamId.toString())
      Object.assign(team, { status })
    },
    async recordEvent(doc) {
      const event = { _id: new ObjectId(), ...doc }
      events.push(event)
      return event
    },
  }
}

describe('AgentTeamOrchestrator', () => {
  it('runs a structured child task with monotonic tools, context pack, result, and team events', async () => {
    const store = createStore()
    const childSessionId = new ObjectId()
    const capability = {
      name: 'content-reviewer',
      version: '1.0.0',
      role: 'worker',
      defaultPolicy: {
        tools: ['read_document', 'search_project'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 5,
        allowSpawn: false,
        allowHandoff: false,
      },
      contextPolicy: {
        includeParentHistory: false,
        includeProjectInstructions: true,
        includeMemories: true,
        maxMemories: 1,
      },
      outputSchema: { type: 'object' },
    }
    const capabilityRegistry = { get: vi.fn(() => capability) }
    const agentController = {
      createChildSession: vi.fn(async input => ({
        _id: childSessionId,
        ...input,
      })),
    }
    const childRunner = vi.fn(async () => ({
      summary: 'Found one unsupported claim.',
      findings: [
        {
          severity: 'major',
          category: 'evidence',
          title: 'Unsupported claim',
          description: 'The claim needs evidence.',
          evidenceRefs: [{ path: 'main.tex', locator: 'Section 1' }],
        },
      ],
      usage: { llmCalls: 1, toolCalls: 1 },
      events: [{ type: 'agent_task.progress', payload: { step: 'read main.tex' } }],
    }))
    const orchestrator = new AgentTeamOrchestrator({
      store,
      capabilityRegistry,
      agentController,
      childRunner,
    })

    const result = await orchestrator.startAgentTask({
      sessionId: new ObjectId().toString(),
      projectId: 'project-1',
      userId: 'user-1',
      toolCallId: 'call-1',
      rootSessionId: new ObjectId().toString(),
      activeChangeSetId: new ObjectId().toString(),
      parentPolicy: {
        tools: ['read_document', 'edit_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 2,
        maxToolCalls: 10,
        allowSpawn: false,
        allowHandoff: false,
      },
      taskSpec: {
        capabilityName: 'content-reviewer',
        capabilityVersion: '1.0.0',
        mode: 'tool',
        objective: 'Review main.tex for unsupported claims.',
        acceptanceCriteria: ['Every finding has evidence.'],
        input: {
          userRequest: 'Review apiKey=secret-value',
          files: [
            {
              path: 'main.tex',
              mode: 'excerpt',
              content: 'A strong claim.',
              reason: 'primary file',
            },
          ],
        },
        outputSchema: { type: 'object' },
        contextPolicy: {
          includeSessionSummary: true,
          includeRecalledContext: true,
        },
        policy: {
          tools: ['read_document', 'run_command'],
          fileGlobs: ['main.tex'],
          writeGlobs: [],
          network: 'allow',
          modelTiers: ['standard'],
          maxDepth: 1,
          maxParallelTasks: 2,
          maxToolCalls: 20,
        },
        timeoutMs: 30000,
      },
      projectInstructions: {
        content: 'Review according to AGENTS.md.',
        path: 'AGENTS.md',
        docId: 'doc-instructions',
      },
      memories: [
        {
          id: 'memory-1',
          content: 'Prefer concise reviewer findings.',
          scope: 'project',
          source: 'manual',
        },
        {
          id: 'memory-2',
          content: 'Should not be selected.',
          scope: 'global',
          source: 'manual',
        },
      ],
      sessionSummary: {
        id: 'summary-1',
        summary: 'Parent already inspected the introduction.',
      },
      recalledContext: [
        {
          id: 'recall-1',
          type: 'memory',
          content: 'Recall this selected note.',
        },
      ],
    })

    expect(result).toMatchObject({
      teamId: store.teams[0]._id.toString(),
      taskId: store.tasks[0]._id.toString(),
      childSessionId: childSessionId.toString(),
      status: 'completed',
      result: {
        summary: 'Found one unsupported claim.',
        findings: [
          expect.objectContaining({
            severity: 'major',
            title: 'Unsupported claim',
          }),
        ],
      },
      allowedToolNames: ['read_document'],
    })
    expect(agentController.createChildSession).toHaveBeenCalledWith(expect.objectContaining({
      parentId: expect.any(String),
      projectId: 'project-1',
      userId: 'user-1',
      agentName: 'content-reviewer',
      requestedToolNames: ['read_document', 'run_command'],
      allowedToolNames: ['read_document'],
    }))
    expect(childRunner).toHaveBeenCalledWith(expect.objectContaining({
      task: store.tasks[0],
      contextPack: store.contextPacks[0],
      childSession: expect.objectContaining({ _id: childSessionId }),
      allowedToolNames: ['read_document'],
    }))
    expect(store.contextPacks[0]).toMatchObject({
      projectInstructions: {
        content: 'Review according to AGENTS.md.',
        path: 'AGENTS.md',
      },
      memories: [
        expect.objectContaining({
          id: 'memory-1',
          content: 'Prefer concise reviewer findings.',
        }),
      ],
      sessionSummary: expect.objectContaining({
        summary: 'Parent already inspected the introduction.',
      }),
      recalledContext: [
        expect.objectContaining({
          content: 'Recall this selected note.',
        }),
      ],
      sourceCounts: expect.objectContaining({
        projectInstructions: 1,
        memories: 1,
        sessionSummary: 1,
        recalledContext: 1,
      }),
    })
    expect(Reflect.get(store.contextPacks[0], 'project' + 'Rules')).toBeUndefined()
    expect(JSON.stringify(store.contextPacks[0])).not.toContain('secret-value')
    expect(JSON.stringify(store.contextPacks[0])).not.toContain('Should not be selected')
    expect(store.events.find(event => event.type === 'agent_task.queued').payload.contextSourceCounts).toMatchObject({
      projectInstructions: 1,
      memories: 1,
      sessionSummary: 1,
      recalledContext: 1,
    })
    expect(store.events.map(event => event.type)).toEqual([
      'agent_team.started',
      'agent_task.queued',
      'agent_task.started',
      'agent_task.progress',
      'agent_task.completed',
      'agent_team.completed',
    ])
  })

  it('runs a built-in general agent with sandbox command permissions without recursive spawn tools', async () => {
    const store = createStore()
    const childSessionId = new ObjectId()
    const agentController = {
      createChildSession: vi.fn(async input => ({
        _id: childSessionId,
        ...input,
      })),
    }
    const childRunner = vi.fn(async () => ({
      status: 'completed',
      summary: '78*98=7644',
      findings: [],
      usage: { llmCalls: 1, toolCalls: 1 },
      events: [{ type: 'agent_task.progress', payload: { step: 'ran command' } }],
    }))
    const orchestrator = new AgentTeamOrchestrator({
      store,
      agentController,
      childRunner,
    })

    const result = await orchestrator.startAgentTask({
      sessionId: new ObjectId().toString(),
      rootSessionId: new ObjectId().toString(),
      projectId: 'project-1',
      userId: 'user-1',
      parentPolicy: {
        tools: [
          'read_document',
          'list_files',
          'search_project',
          'run_command',
          'write_workspace_file',
          'start_agent_task',
          'start_agent_team',
        ],
        fileGlobs: ['**/*'],
        writeGlobs: ['.agent/tmp/**', '.agent/scripts/**'],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 3,
        maxToolCalls: 10,
        allowSpawn: false,
        allowHandoff: false,
      },
      taskSpec: {
        capabilityName: 'general-agent',
        mode: 'tool',
        objective: 'Use a shell command to calculate 78*98.',
        acceptanceCriteria: ['Return exactly the computed product.'],
        outputSchema: { type: 'object' },
        policy: {
          tools: ['run_command', 'start_agent_task'],
          fileGlobs: ['**/*'],
          writeGlobs: ['.agent/tmp/**'],
          network: 'deny',
          modelTiers: ['standard'],
          maxToolCalls: 2,
        },
      },
    })

    expect(result.status).toBe('completed')
    expect(result.allowedToolNames).toContain('run_command')
    expect(result.allowedToolNames).not.toContain('start_agent_task')
    expect(agentController.createChildSession).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'general-agent',
      requestedToolNames: expect.arrayContaining(['run_command']),
      allowedToolNames: expect.arrayContaining(['run_command']),
    }))
    expect(childRunner).toHaveBeenCalledWith(expect.objectContaining({
      allowedToolNames: expect.arrayContaining(['run_command']),
      policy: expect.objectContaining({
        tools: expect.arrayContaining(['run_command']),
        writeGlobs: ['.agent/tmp/**'],
      }),
    }))
  })

  it('fails a child task before persistence when structured findings are malformed', async () => {
    const store = createStore()
    const capability = {
      name: 'content-reviewer',
      version: '1.0.0',
      role: 'worker',
      defaultPolicy: {
        tools: ['read_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 5,
        allowSpawn: false,
        allowHandoff: false,
      },
      contextPolicy: {},
      outputSchema: { type: 'object' },
    }
    const orchestrator = new AgentTeamOrchestrator({
      store,
      capabilityRegistry: { get: vi.fn(() => capability) },
      agentController: {
        createChildSession: vi.fn(async input => ({ _id: new ObjectId(), ...input })),
      },
      childRunner: vi.fn(async () => ({
        summary: 'Malformed finding',
        findings: [{ severity: 'major', title: 'Missing evidence' }],
      })),
    })

    const result = await orchestrator.startAgentTask({
      sessionId: new ObjectId().toString(),
      rootSessionId: new ObjectId().toString(),
      projectId: 'project-1',
      userId: 'user-1',
      parentPolicy: {
        tools: ['read_document'],
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
      taskSpec: {
        capabilityName: 'content-reviewer',
        mode: 'tool',
        objective: 'Review.',
        acceptanceCriteria: ['Return findings.'],
        outputSchema: { type: 'object' },
        policy: { tools: ['read_document'] },
      },
    })

    expect(result.status).toBe('failed')
    expect(store.tasks[0].status).toBe('failed')
    expect(store.results[0]).toMatchObject({
      status: 'failed',
      summary: 'major and critical findings require at least one evidence ref',
    })
    expect(store.events.map(event => event.type)).toContain('agent_task.failed')
  })

  it('persists timeout child results as retryable task failures', async () => {
    const store = createStore()
    const capability = {
      name: 'content-reviewer',
      version: '1.0.0',
      role: 'worker',
      defaultPolicy: {
        tools: ['read_document'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 0,
        maxParallelTasks: 1,
        maxToolCalls: 5,
        allowSpawn: false,
        allowHandoff: false,
      },
      contextPolicy: {},
      outputSchema: { type: 'object' },
    }
    const orchestrator = new AgentTeamOrchestrator({
      store,
      capabilityRegistry: { get: vi.fn(() => capability) },
      agentController: {
        createChildSession: vi.fn(async input => ({ _id: new ObjectId(), ...input })),
      },
      childRunner: vi.fn(async () => ({
        status: 'timeout',
        summary: 'Reviewer timed out.',
        usage: { llmCalls: 1 },
      })),
    })

    const result = await orchestrator.startAgentTask({
      sessionId: new ObjectId().toString(),
      rootSessionId: new ObjectId().toString(),
      projectId: 'project-1',
      userId: 'user-1',
      parentPolicy: {
        tools: ['read_document'],
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
      taskSpec: {
        capabilityName: 'content-reviewer',
        mode: 'tool',
        objective: 'Review.',
        acceptanceCriteria: ['Return findings.'],
        outputSchema: { type: 'object' },
        policy: { tools: ['read_document'] },
      },
    })

    expect(result.status).toBe('timeout')
    expect(store.tasks[0].status).toBe('timeout')
    expect(store.teams[0].status).toBe('failed')
    expect(store.events.map(event => event.type)).toContain('agent_task.timeout')
  })
})
