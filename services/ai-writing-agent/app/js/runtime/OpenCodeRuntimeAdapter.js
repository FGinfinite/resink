import {
  CommandRuntimeAdapter,
  redactRuntimeValue,
} from './CommandRuntimeAdapter.js'

const DEFAULT_BINARY = 'opencode'
const DEFAULT_RUN_ARGS = ['run']
const DEFAULT_PROVIDER_ID = 'overleaf'

function buildOpenCodeConfigEnv(env = {}) {
  if (env.OPENCODE_CONFIG_CONTENT) return {}
  const apiBase = env.OPENAI_API_BASE
  const model = env.OPENAI_MODEL
  if (!apiBase || !model) return {}

  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: {
        [DEFAULT_PROVIDER_ID]: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Overleaf OpenAI Compatible',
          options: {
            baseURL: apiBase,
            apiKey: '{env:OPENAI_API_KEY}',
          },
          models: {
            [model]: {
              name: model,
            },
          },
        },
      },
      model: `${DEFAULT_PROVIDER_ID}/${model}`,
      small_model: `${DEFAULT_PROVIDER_ID}/${model}`,
      enabled_providers: [DEFAULT_PROVIDER_ID],
    }),
  }
}

function resolveDefaultModel(options = {}, env = {}) {
  if (options.model) return options.model
  if (env.OPENAI_MODEL) return `${DEFAULT_PROVIDER_ID}/${env.OPENAI_MODEL}`
  return null
}

export { redactRuntimeValue }

export class OpenCodeRuntimeAdapter extends CommandRuntimeAdapter {
  constructor(options = {}) {
    const configuredBaseEnv = {
      ...(options.baseEnv || process.env),
    }
    Object.assign(configuredBaseEnv, buildOpenCodeConfigEnv(configuredBaseEnv))

    super({
      id: 'opencode',
      displayName: 'OpenCode',
      binary: options.binary || DEFAULT_BINARY,
      runArgs: options.runArgs || DEFAULT_RUN_ARGS,
      detectArgs: options.detectArgs || ['--version'],
      baseEnv: configuredBaseEnv,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
      maxEventBytes: options.maxEventBytes,
      missingBinaryMessage: `OpenCode binary not found: ${options.binary || DEFAULT_BINARY}`,
      authFailureLabel: 'OpenCode',
    })
    this.model = resolveDefaultModel(options, configuredBaseEnv)
  }

  buildRunArgs(input, prompt) {
    if (input.runArgs) return [...input.runArgs, prompt]
    const args = [...this.runArgs]
    const model = input.model || this.model
    if (model) args.push('--model', model)
    args.push('--dir', input.containerWorkspacePath || '/workspace')
    args.push(prompt)
    return args
  }
}

export default OpenCodeRuntimeAdapter
