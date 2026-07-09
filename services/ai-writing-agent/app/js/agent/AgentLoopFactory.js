import {
  AGENT_LOOP_V2_RUNTIME,
  AgentLoopV2,
} from './AgentLoopV2.js'

export function resolveAgentLoopRuntime() {
  return AGENT_LOOP_V2_RUNTIME
}

export function createAgentLoopForSession(session, options) {
  const runtimeMode = resolveAgentLoopRuntime(session)
  const agentLoopPath = runtimeMode
  const loop = new AgentLoopV2({
    ...options,
    runtimeMode,
    agentLoopPath,
  })
  loop.runtimeMode = runtimeMode
  loop.agentLoopPath = agentLoopPath
  return loop
}
