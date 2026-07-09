const DEFAULT_CODEX_MODEL = 'gpt-5.2-codex'
const DEFAULT_CODEX_REASONING_EFFORT = 'medium'
const DEFAULT_CODEX_SANDBOX_MODE = 'workspace-write'

export class RuntimeAdapterFactoryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuntimeAdapterFactoryError'
    this.code = 'RUNTIME_ADAPTER_INVALID_INPUT'
    this.statusCode = 400
  }
}

export async function createRuntimeAdapter(config) {
  const adapter = config.agentRuntime.adapter
  const sharedOptions = {
    binary: config.agentRuntime.executable,
    timeoutMs: config.sandbox.commandTimeoutMs,
    maxEventBytes: config.sandbox.maxOutputBytes,
  }

  if (adapter === 'opencode') {
    const { OpenCodeRuntimeAdapter } = await import(
      './OpenCodeRuntimeAdapter.js'
    )
    return new OpenCodeRuntimeAdapter({
      ...sharedOptions,
      model: config.agentRuntime.model,
    })
  }

  if (adapter === 'codex') {
    const { CodexRuntimeAdapter } = await import('./CodexRuntimeAdapter.js')
    return new CodexRuntimeAdapter({
      ...sharedOptions,
      model: config.agentRuntime.model || DEFAULT_CODEX_MODEL,
      reasoningEffort:
        config.agentRuntime.reasoningEffort ||
        DEFAULT_CODEX_REASONING_EFFORT,
      sandboxMode:
        config.agentRuntime.sandboxMode || DEFAULT_CODEX_SANDBOX_MODE,
    })
  }

  throw new RuntimeAdapterFactoryError(`Unsupported runtime adapter: ${adapter}`)
}

export default createRuntimeAdapter
