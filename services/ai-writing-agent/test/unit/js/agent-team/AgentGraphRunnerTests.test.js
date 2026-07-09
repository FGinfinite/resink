import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'

const { AgentGraphRunner } = await import(
  '../../../../app/js/agent-team/AgentGraphRunner.js'
)

function createStore() {
  const events = []
  return {
    events,
    recordEvent: vi.fn(async event => {
      events.push({ _id: new ObjectId(), ...event })
      return events[events.length - 1]
    }),
  }
}

describe('AgentGraphRunner', () => {
  it('runs deep review reviewer fan-out in parallel and then reducer and critic nodes', async () => {
    const store = createStore()
    const started = []
    let runningReviewers = 0
    let maxConcurrentReviewers = 0
    const taskRunner = vi.fn(async ({ node, inputs }) => {
      if (node.kind === 'agent-task') {
        started.push(node.id)
        runningReviewers += 1
        maxConcurrentReviewers = Math.max(maxConcurrentReviewers, runningReviewers)
        await Promise.resolve()
        runningReviewers -= 1
        if (node.id === 'quality-checker') {
          throw new Error('quality checker unavailable')
        }
        return {
          status: 'completed',
          taskId: `task-${node.id}`,
          summary: `${node.id} summary`,
          findings: [{ title: `${node.id} finding` }],
        }
      }
      return {
        status: 'completed',
        summary: `${node.id} complete`,
        inputCount: inputs.length,
      }
    })
    const runner = new AgentGraphRunner({
      store,
      taskRunner,
    })

    const result = await runner.run({
      team: {
        _id: new ObjectId(),
        rootSessionId: new ObjectId(),
        policySummary: { maxParallelTasks: 3 },
      },
      graph: {
        id: 'deep-review',
        nodes: [
          {
            id: 'reviewers',
            kind: 'parallel',
            nodes: [
              { id: 'content-reviewer', kind: 'agent-task' },
              { id: 'experiment-reviewer', kind: 'agent-task' },
              { id: 'quality-checker', kind: 'agent-task' },
            ],
          },
          { id: 'reducer', kind: 'reducer', dependsOn: ['reviewers'] },
          { id: 'critic', kind: 'critic', dependsOn: ['reducer'] },
        ],
      },
      context: {},
    })

    expect(started).toEqual([
      'content-reviewer',
      'experiment-reviewer',
      'quality-checker',
    ])
    expect(maxConcurrentReviewers).toBe(3)
    expect(result.status).toBe('degraded')
    expect(result.results.reviewers.status).toBe('degraded')
    expect(result.results.reviewers.results).toHaveLength(3)
    expect(result.results.reducer).toMatchObject({
      status: 'completed',
      inputCount: 1,
    })
    expect(result.results.critic).toMatchObject({
      status: 'completed',
      inputCount: 1,
    })
    expect(store.events.map(event => event.type)).toEqual([
      'agent_graph.node_started',
      'agent_graph.node_started',
      'agent_graph.node_started',
      'agent_graph.node_started',
      'agent_graph.node_completed',
      'agent_graph.node_completed',
      'agent_graph.node_failed',
      'agent_graph.node_completed',
      'agent_graph.node_started',
      'agent_graph.node_completed',
      'agent_graph.node_started',
      'agent_graph.node_completed',
    ])
  })

  it('limits parallel graph execution to the team policy budget', async () => {
    const store = createStore()
    let running = 0
    let maxRunning = 0
    const taskRunner = vi.fn(async ({ node }) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise(resolve => setTimeout(resolve, 1))
      running -= 1
      return {
        status: 'completed',
        taskId: `task-${node.id}`,
        summary: `${node.id} summary`,
      }
    })
    const runner = new AgentGraphRunner({
      store,
      taskRunner,
    })

    const result = await runner.run({
      team: {
        _id: new ObjectId(),
        rootSessionId: new ObjectId(),
        policySummary: { maxParallelTasks: 2 },
      },
      graph: {
        id: 'budgeted-parallel',
        nodes: [
          {
            id: 'reviewers',
            kind: 'parallel',
            nodes: [
              { id: 'a', kind: 'agent-task' },
              { id: 'b', kind: 'agent-task' },
              { id: 'c', kind: 'agent-task' },
              { id: 'd', kind: 'agent-task' },
            ],
          },
        ],
      },
    })

    expect(maxRunning).toBe(2)
    expect(taskRunner).toHaveBeenCalledTimes(4)
    expect(result.results.reviewers).toMatchObject({
      status: 'completed',
    })
  })
})
