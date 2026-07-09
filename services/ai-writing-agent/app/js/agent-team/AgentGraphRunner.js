export class AgentGraphRunner {
  constructor(options = {}) {
    if (!options.store) throw new Error('AgentGraphRunner requires store')
    if (!options.taskRunner) throw new Error('AgentGraphRunner requires taskRunner')
    this.store = options.store
    this.taskRunner = options.taskRunner
  }

  async run(input = {}) {
    const team = requireTeam(input.team)
    const graph = normalizeGraph(input.graph)
    const state = {
      team,
      sessionId: input.sessionId || team.rootSessionId,
      context: input.context || {},
      results: {},
    }

    for (const node of graph.nodes) {
      await this.runNode(node, state)
    }

    return {
      graphId: graph.id,
      status: aggregateGraphStatus(Object.values(state.results)),
      results: state.results,
    }
  }

  async runNode(node, state) {
    await this.recordNodeEvent('agent_graph.node_started', node, state)
    try {
      const result = await this.executeNode(node, state)
      state.results[node.id] = result
      await this.recordNodeEvent('agent_graph.node_completed', node, state, {
        status: result.status || 'completed',
        degraded: result.status === 'degraded',
      })
      return result
    } catch (error) {
      const failed = {
        status: 'failed',
        error: sanitizeError(error),
      }
      state.results[node.id] = failed
      await this.recordNodeEvent('agent_graph.node_failed', node, state, failed)
      return failed
    }
  }

  async executeNode(node, state) {
    if (node.kind === 'sequence') {
      const results = []
      for (const child of node.nodes || []) {
        results.push(await this.runNode(child, state))
      }
      return {
        status: results.some(result => result.status === 'failed')
          ? 'degraded'
          : 'completed',
        results,
      }
    }

    if (node.kind === 'parallel') {
      const childNodes = node.nodes || []
      const settled = await runLimited(
        childNodes,
        parallelLimit(state.team.policySummary?.maxParallelTasks),
        child => this.runNode(child, state)
      )
      const results = settled.map((item, index) => {
        if (item.status === 'fulfilled') return item.value
        return {
          status: 'failed',
          nodeId: childNodes[index]?.id || null,
          error: sanitizeError(item.reason),
        }
      })
      return {
        status: results.some(result => result.status === 'failed')
          ? 'degraded'
          : 'completed',
        results,
      }
    }

    if (['agent-task', 'reducer', 'critic'].includes(node.kind)) {
      return this.taskRunner({
        node,
        inputs: collectInputs(node, state.results),
        context: state.context,
        team: state.team,
      })
    }

    if (node.kind === 'condition') {
      const selected = resolveConditionNode(node, state.results)
      if (!selected) return { status: 'skipped' }
      return this.runNode(selected, state)
    }

    if (node.kind === 'loop') {
      return this.runLoopNode(node, state)
    }

    throw new Error(`Unsupported graph node kind: ${node.kind}`)
  }

  async runLoopNode(node, state) {
    const maxIterations = normalizeLoopCap(node.maxIterations)
    const results = []
    for (let index = 0; index < maxIterations; index += 1) {
      for (const child of node.nodes || []) {
        results.push(await this.runNode({
          ...child,
          id: `${child.id}:${index + 1}`,
        }, state))
      }
      if (!node.repeatWhile) break
    }
    return {
      status: results.some(result => result.status === 'failed')
        ? 'degraded'
        : 'completed',
      results,
    }
  }

  async recordNodeEvent(type, node, state, payload = {}) {
    return this.store.recordEvent({
      teamId: state.team._id,
      sessionId: state.sessionId,
      type,
      payload: {
        nodeId: node.id,
        nodeKind: node.kind,
        ...payload,
      },
    })
  }
}

function normalizeGraph(graph) {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph is required')
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error('graph.nodes must be a non-empty array')
  }
  return {
    id: graph.id || 'graph',
    nodes: graph.nodes,
  }
}

function requireTeam(team) {
  if (!team?._id) throw new Error('team is required')
  return team
}

function collectInputs(node, results) {
  return (node.dependsOn || []).map(id => ({
    nodeId: id,
    result: results[id] || null,
  }))
}

function resolveConditionNode(node, results) {
  if (typeof node.select !== 'function') return node.elseNode || null
  return node.select(results) ? node.thenNode : node.elseNode
}

function normalizeLoopCap(value) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 1) return 1
  return Math.min(numeric, 10)
}

function parallelLimit(value) {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 1) return 1
  return numeric
}

async function runLimited(items, limit, runner) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await runner(items[index]) }
      } catch (error) {
        results[index] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function sanitizeError(error) {
  return {
    message: String(error?.message || error || 'Unknown error').slice(0, 500),
    code: typeof error?.code === 'string' ? error.code.slice(0, 100) : null,
  }
}

function aggregateGraphStatus(results) {
  const terminal = results.map(result => result?.status)
  if (terminal.some(status => status === 'degraded')) return 'degraded'
  if (terminal.some(status => status === 'failed')) {
    return terminal.some(status => status === 'completed') ? 'degraded' : 'failed'
  }
  return 'completed'
}

export default AgentGraphRunner
