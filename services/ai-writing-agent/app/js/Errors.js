import OError from '@overleaf/o-error'

export class AIAgentError extends OError {
  constructor(message, info = {}) {
    super(message, info)
    this.status = info.status || 500
    this.code = info.code || 'INTERNAL_ERROR'
  }
}

export class SessionNotFoundError extends AIAgentError {
  constructor(sessionId) {
    super('Session not found', {
      status: 404,
      code: 'SESSION_NOT_FOUND',
      sessionId,
    })
  }
}

export class SessionExpiredError extends AIAgentError {
  constructor(sessionId) {
    super('Session has expired', {
      status: 410,
      code: 'SESSION_EXPIRED',
      sessionId,
    })
  }
}

export class ChangeNotFoundError extends AIAgentError {
  constructor(changeId) {
    super('Pending change not found', {
      status: 404,
      code: 'CHANGE_NOT_FOUND',
      changeId,
    })
  }
}

export class ValidationError extends AIAgentError {
  constructor(message, details = null) {
    super(message, {
      status: 400,
      code: 'VALIDATION_ERROR',
      details,
    })
  }
}

export class UnauthorizedError extends AIAgentError {
  constructor(message = 'Unauthorized') {
    super(message, {
      status: 401,
      code: 'UNAUTHORIZED',
    })
  }
}

export class ForbiddenError extends AIAgentError {
  constructor(message = 'Forbidden') {
    super(message, {
      status: 403,
      code: 'FORBIDDEN',
    })
  }
}

export class ConflictError extends AIAgentError {
  constructor(message = 'Conflict') {
    super(message, {
      status: 409,
      code: 'CONFLICT',
    })
  }
}

export class VersionConflictError extends AIAgentError {
  constructor(message, info = {}) {
    super(message, {
      status: 409,
      code: 'VERSION_CONFLICT',
      ...info,
    })
  }
}

export class RebaseConflictError extends AIAgentError {
  constructor(message, info = {}) {
    super(message, {
      status: 409,
      code: 'REBASE_CONFLICT',
      ...info,
    })
  }
}

export class ApplyEditError extends AIAgentError {
  constructor(message, info = {}) {
    super(message, {
      status: 500,
      code: 'APPLY_EDIT_ERROR',
      ...info,
    })
  }
}

export default {
  AIAgentError,
  SessionNotFoundError,
  SessionExpiredError,
  ChangeNotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  VersionConflictError,
  RebaseConflictError,
  ApplyEditError,
}
