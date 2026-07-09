import { RuntimeInvalidInputError } from './RuntimeErrors.js'

export const AgentRuntimeEventTypes = Object.freeze({
  START: 'start',
  COMMAND: 'command',
  LOG: 'log',
  TEXT: 'text',
  RESULT: 'result',
  ERROR: 'error',
  DONE: 'done',
})

export class AgentRuntimeAdapter {
  constructor({ id, displayName } = {}) {
    if (!id) {
      throw new RuntimeInvalidInputError('Runtime adapter id is required')
    }
    if (!displayName) {
      throw new RuntimeInvalidInputError('Runtime adapter displayName is required')
    }
    this.id = id
    this.displayName = displayName
  }

  async detect() {
    throw new Error(`${this.constructor.name}.detect() must be implemented`)
  }

  async prepare() {
    // Default no-op. Adapters may install config files inside the sandbox.
  }

  run() {
    throw new Error(`${this.constructor.name}.run() must be implemented`)
  }

  async stop() {
    // Default no-op. Adapters with long-running processes should override.
  }

  requireSandboxSession(input) {
    if (!input?.sandboxSession) {
      throw new RuntimeInvalidInputError('sandboxSession is required')
    }
    if (typeof input.sandboxSession.run !== 'function') {
      throw new RuntimeInvalidInputError('sandboxSession.run(command) is required')
    }
    return input.sandboxSession
  }

  requirePrompt(input) {
    if (!input?.prompt || typeof input.prompt !== 'string') {
      throw new RuntimeInvalidInputError('prompt is required')
    }
    return input.prompt
  }

  normalizeEvent(event) {
    if (!event || typeof event !== 'object') {
      return { type: AgentRuntimeEventTypes.LOG, stream: 'stdout', content: String(event ?? '') }
    }

    if (Object.values(AgentRuntimeEventTypes).includes(event.type)) {
      return event
    }

    if (event.type === 'stdout' || event.stream === 'stdout') {
      return {
        type: AgentRuntimeEventTypes.TEXT,
        stream: 'stdout',
        content: event.content ?? event.data ?? '',
      }
    }

    if (event.type === 'stderr' || event.stream === 'stderr') {
      return {
        type: AgentRuntimeEventTypes.LOG,
        level: 'warn',
        stream: 'stderr',
        content: event.content ?? event.data ?? '',
      }
    }

    if (event.type === 'exit') {
      return {
        type: AgentRuntimeEventTypes.DONE,
        exitCode: event.exitCode ?? event.code ?? null,
      }
    }

    return {
      type: AgentRuntimeEventTypes.LOG,
      content: event.content ?? event.data ?? JSON.stringify(event),
    }
  }
}
