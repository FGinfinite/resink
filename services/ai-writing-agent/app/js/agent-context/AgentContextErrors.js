export class AgentContextError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message)
    this.name = 'AgentContextError'
    this.code = code
    this.statusCode = statusCode
    this.status = statusCode
  }
}

export function notFound(message, code) {
  return new AgentContextError(message, code, 404)
}

export function validationError(message, code = 'AGENT_CONTEXT_VALIDATION_ERROR') {
  return new AgentContextError(message, code, 400)
}

export function conflictError(message, code = 'AGENT_CONTEXT_CONFLICT') {
  return new AgentContextError(message, code, 409)
}
