import { AgentCapabilityRegistry } from './AgentCapabilityRegistry.js'
import { BUILT_IN_AGENT_CAPABILITIES } from './capabilities/builtInCapabilities.js'

export async function getAgentTeamRuntimeStatus(options = {}) {
  const registry = options.registry || new AgentCapabilityRegistry({
    definitions: options.definitions || BUILT_IN_AGENT_CAPABILITIES,
  })
  const diagnostics = await registry.loadAll()

  return {
    status: 'ok',
    capabilityRegistry: diagnostics,
    capabilities: registry.listMetadata(),
  }
}

export default getAgentTeamRuntimeStatus
