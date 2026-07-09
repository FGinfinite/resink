import { CommandRuntimeAdapter } from './CommandRuntimeAdapter.js'

const DEFAULT_BINARY = 'codex'
const DEFAULT_MODEL = 'gpt-5.2-codex'
const DEFAULT_REASONING_EFFORT = 'medium'

export class CodexRuntimeAdapter extends CommandRuntimeAdapter {
  constructor(options = {}) {
    const binary = options.binary || DEFAULT_BINARY
    super({
      id: 'codex',
      displayName: 'Codex CLI',
      binary,
      runArgs: options.runArgs,
      detectArgs: options.detectArgs || ['--version'],
      baseEnv: options.baseEnv,
      runner: options.runner,
      timeoutMs: options.timeoutMs,
      maxEventBytes: options.maxEventBytes,
      missingBinaryMessage: `Codex CLI binary not found: ${binary}`,
      authFailureLabel: 'Codex CLI',
    })
    this.model = options.model || DEFAULT_MODEL
    this.reasoningEffort = options.reasoningEffort || DEFAULT_REASONING_EFFORT
    this.sandboxMode = options.sandboxMode || 'workspace-write'
  }

  buildRunArgs(input, prompt) {
    if (input.runArgs) return [...input.runArgs, prompt]
    return [
      'exec',
      '--skip-git-repo-check',
      '-m',
      input.model || this.model,
      '-c',
      `model_reasoning_effort="${input.reasoningEffort || this.reasoningEffort}"`,
      '--sandbox',
      input.sandboxMode || this.sandboxMode,
      '--full-auto',
      '-C',
      input.cwd || input.sandboxSession?.workspacePath || '.',
      prompt,
    ]
  }
}

export default CodexRuntimeAdapter
