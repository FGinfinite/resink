import logger from '@overleaf/logger'
import { getAgentRuntimeConfig } from '../RuntimeConfigManager.js'
import { LocalDockerSandboxProvider } from './LocalDockerSandboxProvider.js'

export async function runSandboxStartupCleanup(options = {}) {
  const getRuntimeConfig = options.getRuntimeConfig || getAgentRuntimeConfig
  const log = options.logger || logger
  const Provider =
    options.LocalDockerSandboxProvider || LocalDockerSandboxProvider
  const config = getRuntimeConfig()

  if (!config.sandboxEnabled || config.sandbox.provider !== 'local-docker') {
    return { skipped: true, reason: 'sandbox-disabled-or-non-local-provider' }
  }

  const provider = new Provider({
    image: config.sandbox.image,
    timeoutMs: config.sandbox.commandTimeoutMs,
    maxOutputBytes: config.sandbox.maxOutputBytes,
    maxArtifactBytes: config.sandbox.maxArtifactBytes,
    maxFileCount: config.sandbox.maxFileCount,
    networkPolicy: config.sandbox.networkPolicy,
    memoryBytes: config.sandbox.memoryBytes,
    memorySwapBytes: config.sandbox.memorySwapBytes,
    cpuCount: config.sandbox.cpuCount,
    pidsLimit: config.sandbox.pidsLimit,
  })

  const result = await provider.startupCleanup()
  log.info(
    {
      removedContainers: result.removedContainers.length,
      removedWorkspaces: result.removedWorkspaces.length,
    },
    'sandbox startup cleanup complete'
  )
  return { skipped: false, ...result }
}

export default runSandboxStartupCleanup
