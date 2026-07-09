import { AgentLoop } from './AgentLoop.js'

export const AGENT_LOOP_V2_RUNTIME = 'agent-loop-v2'

export class AgentLoopV2 extends AgentLoop {
  constructor(options) {
    super(options)
    this.runtimeMode = AGENT_LOOP_V2_RUNTIME
    this.runtimeVersion = 'v2'
  }
}

export function createAgentLoopV2(options) {
  return new AgentLoopV2(options)
}

export default AgentLoopV2
