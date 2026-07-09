import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const { createDeepReviewGraph } = await import(
  '../../../../app/js/agent-team/workflows/deepReviewWorkflow.js'
)
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
      const team = { _id: new ObjectId(), status: 'queued', ...doc }
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
        mode: spec.mode,
        objective: spec.objective,
        policy: spec.policy,
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
    async markTaskRunning({ taskId, childSessionId }) {
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, { status: 'running', childSessionId })
    },
    async completeTask({ taskId, teamId, result, usage }) {
      const resultDoc = { _id: new ObjectId(), taskId, teamId, ...result, usage }
      results.push(resultDoc)
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, { status: 'completed', resultId: resultDoc._id })
      return resultDoc
    },
    async recordEvent(doc) {
      const event = { _id: new ObjectId(), ...doc }
      events.push(event)
      return event
    },
  }
}

function capability(name, role = 'worker') {
  return {
    name,
    version: '1.0.0',
    role,
    defaultPolicy: {
      tools: ['read_document'],
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
    contextPolicy: {},
    outputSchema: { type: 'object' },
  }
}

describe('deep review workflow', () => {
  it('creates a workflow graph with parallel reviewers, reducer, and critic tasks', async () => {
    const store = createStore()
    const capabilities = new Map([
      ['content-reviewer', capability('content-reviewer')],
      ['experiment-reviewer', capability('experiment-reviewer')],
      ['quality-checker', capability('quality-checker')],
      ['deep-review-reducer', capability('deep-review-reducer', 'reducer')],
      ['deep-review-critic', capability('deep-review-critic', 'critic')],
    ])
    const childRunner = vi.fn(async ({ capability }) => ({
      summary: `${capability.name} done`,
      findings: [
        {
          severity: 'major',
          category: 'evidence',
          title: `${capability.name} finding`,
          description: 'Reviewer found an evidence-backed issue.',
          evidenceRefs: [{ path: 'main.tex', locator: capability.name }],
          suggestedFix: 'Revise the relevant passage.',
          confidence: 0.8,
        },
      ],
      usage: { toolCalls: 1 },
      events: [],
    }))
    const orchestrator = new AgentTeamOrchestrator({
      store,
      capabilityRegistry: { get: name => capabilities.get(name) },
      agentController: {
        createChildSession: vi.fn(async input => ({ _id: new ObjectId(), ...input })),
      },
      childRunner,
    })
    const team = await store.createTeamRun({
      projectId: 'project-1',
      userId: 'user-1',
      rootSessionId: new ObjectId(),
      workflowType: 'deep-review',
      mode: 'workflow-graph',
      startedBy: 'model',
    })

    const result = await orchestrator.runWorkflowGraph({
      team,
      graph: createDeepReviewGraph({
        userRequest: 'Review the paper.',
        files: [{ path: 'main.tex', mode: 'excerpt', reason: 'main paper' }],
      }),
      sessionId: team.rootSessionId.toString(),
      rootSessionId: team.rootSessionId.toString(),
      projectId: 'project-1',
      userId: 'user-1',
      parentPolicy: {
        tools: ['read_document', 'search_project'],
        fileGlobs: ['**/*.tex'],
        writeGlobs: [],
        network: 'deny',
        pythonEnvironments: [],
        modelTiers: ['standard'],
        maxDepth: 1,
        maxParallelTasks: 3,
        maxToolCalls: 12,
        allowSpawn: false,
        allowHandoff: false,
      },
    })

    expect(result.status).toBe('completed')
    expect(tasksByAgentName(store.tasks)).toEqual([
      'content-reviewer',
      'experiment-reviewer',
      'quality-checker',
      'deep-review-reducer',
      'deep-review-critic',
    ])
    expect(result.results.reviewers.status).toBe('completed')
    expect(result.results.reducer.result.summary).toContain('unique findings')
    expect(result.results.critic.result.summary).toContain('# Deep Review Report')
    expect(store.events.map(event => event.type)).toContain('agent_graph.node_started')
    expect(store.events.map(event => event.type)).toContain('agent_graph.node_completed')
  })
})

function tasksByAgentName(tasks) {
  return tasks.map(task => task.agentName)
}
