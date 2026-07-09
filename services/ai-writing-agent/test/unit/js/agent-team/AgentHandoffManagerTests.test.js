import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const { AgentHandoffManager } = await import(
  '../../../../app/js/agent-team/AgentHandoffManager.js'
)
const { AgentPolicyError } = await import(
  '../../../../app/js/agent-team/AgentPolicyEngine.js'
)

function createStore() {
  const teams = []
  const tasks = []
  const events = []
  const sessions = []
  return {
    teams,
    tasks,
    events,
    sessions,
    db: {
      aiSessions: {
        updateOne: vi.fn(async (filter, update) => {
          sessions.push({ filter, update })
          return { matchedCount: 1, modifiedCount: 1 }
        }),
      },
    },
    async createTeamRun(doc) {
      const team = { _id: new ObjectId(), ...doc }
      teams.push(team)
      return team
    },
    async createTaskFromSpec({ teamId, rootSessionId, spec }) {
      const task = {
        _id: new ObjectId(),
        teamId,
        rootSessionId,
        agentName: spec.capabilityName,
        mode: spec.mode,
        status: 'queued',
        policy: spec.policy,
      }
      tasks.push(task)
      return task
    },
    async markTaskRunning({ taskId, childSessionId }) {
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, { status: 'running', childSessionId })
    },
    async completeTask({ taskId, teamId, result }) {
      const task = tasks.find(item => item._id.toString() === taskId.toString())
      Object.assign(task, { status: 'completed', resultId: new ObjectId() })
      return { _id: task.resultId, taskId, teamId, ...result }
    },
    async recordEvent(doc) {
      const event = { _id: new ObjectId(), ...doc }
      events.push(event)
      return event
    },
  }
}

describe('AgentHandoffManager', () => {
  it('starts compile-fixer handoff and records active handoff state', async () => {
    const store = createStore()
    const childSessionId = new ObjectId()
    const manager = new AgentHandoffManager({
      store,
      sessionsCollection: store.db.aiSessions,
      capabilityRegistry: {
        get: () => compileFixerCapability(),
      },
      agentController: {
        createChildSession: vi.fn(async input => ({ _id: childSessionId, ...input })),
      },
    })

    const result = await manager.handoffToAgent({
      sessionId: new ObjectId().toString(),
      rootSessionId: new ObjectId().toString(),
      projectId: 'project-1',
      userId: 'user-1',
      capabilityName: 'compile-fixer',
      objective: 'Fix compile error.',
      parentPolicy: parentPolicy(),
    })

    expect(result).toMatchObject({
      status: 'active',
      capabilityName: 'compile-fixer',
      childSessionId: childSessionId.toString(),
    })
    expect(store.teams[0]).toMatchObject({
      workflowType: 'compile-fix',
      mode: 'handoff',
    })
    expect(store.tasks[0]).toMatchObject({
      mode: 'handoff',
      agentName: 'compile-fixer',
    })
    expect(store.sessions[0].update.$set.activeHandoff).toMatchObject({
      teamId: store.teams[0]._id.toString(),
      taskId: store.tasks[0]._id.toString(),
      childSessionId: childSessionId.toString(),
      capabilityName: 'compile-fixer',
      status: 'active',
    })
    expect(store.events.map(event => event.type)).toEqual([
      'agent_handoff.requested',
      'agent_handoff.accepted',
    ])
  })

  it('rejects handoff policy escalation', async () => {
    const manager = new AgentHandoffManager({
      store: createStore(),
      sessionsCollection: createStore().db.aiSessions,
      capabilityRegistry: { get: () => compileFixerCapability() },
      agentController: { createChildSession: vi.fn() },
    })

    let caughtError
    try {
      await manager.handoffToAgent({
        sessionId: new ObjectId().toString(),
        projectId: 'project-1',
        userId: 'user-1',
        capabilityName: 'compile-fixer',
        objective: 'Fix compile error.',
        parentPolicy: {
          ...parentPolicy(),
          tools: ['read_document'],
        },
      })
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(AgentPolicyError)
    expect(caughtError.info.deniedTools).toEqual([
      'compile_latex',
      'edit_document',
    ])
  })

  it('returns from handoff and clears active state', async () => {
    const store = createStore()
    const manager = new AgentHandoffManager({
      store,
      sessionsCollection: store.db.aiSessions,
      capabilityRegistry: { get: () => compileFixerCapability() },
      agentController: { createChildSession: vi.fn() },
    })

    const result = await manager.returnFromHandoff({
      sessionId: new ObjectId().toString(),
      rootSessionId: new ObjectId().toString(),
      projectId: 'project-1',
      userId: 'user-1',
      teamId: new ObjectId().toString(),
      taskId: new ObjectId().toString(),
      reason: 'completed',
      summary: 'Compile fixed.',
      allowMissingTask: true,
    })

    expect(result.status).toBe('returned')
    expect(store.sessions[0].update.$unset.activeHandoff).toBe('')
    expect(store.events[0].type).toBe('agent_handoff.completed')
  })
})

function compileFixerCapability() {
  return {
    name: 'compile-fixer',
    version: '1.0.0',
    role: 'handoff-specialist',
    defaultPolicy: {
      tools: ['read_document', 'compile_latex', 'edit_document'],
      fileGlobs: ['**/*.tex'],
      writeGlobs: ['**/*.tex'],
      network: 'deny',
      pythonEnvironments: [],
      modelTiers: ['standard'],
      maxDepth: 0,
      maxParallelTasks: 1,
      maxToolCalls: 8,
      allowSpawn: false,
      allowHandoff: true,
    },
    contextPolicy: {},
    outputSchema: { type: 'object' },
  }
}

function parentPolicy() {
  return {
    tools: ['read_document', 'compile_latex', 'edit_document'],
    fileGlobs: ['**/*.tex'],
    writeGlobs: ['**/*.tex'],
    network: 'deny',
    pythonEnvironments: [],
    modelTiers: ['standard'],
    maxDepth: 1,
    maxParallelTasks: 1,
    maxToolCalls: 10,
    allowSpawn: false,
    allowHandoff: true,
  }
}
