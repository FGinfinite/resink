export const RuntimeErrorCodes = Object.freeze({
  MISSING_BINARY: 'MISSING_BINARY',
  AUTH_FAILURE: 'AUTH_FAILURE',
  EXECUTION_FAILURE: 'EXECUTION_FAILURE',
  INVALID_INPUT: 'INVALID_INPUT',
  ABORTED: 'ABORTED',
})

export class RuntimeError extends Error {
  constructor(message, { code = RuntimeErrorCodes.EXECUTION_FAILURE, cause, details } = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.details = details
    if (cause) {
      this.cause = cause
    }
  }
}

export class RuntimeMissingBinaryError extends RuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: RuntimeErrorCodes.MISSING_BINARY })
  }
}

export class RuntimeAuthError extends RuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: RuntimeErrorCodes.AUTH_FAILURE })
  }
}

export class RuntimeExecutionError extends RuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: RuntimeErrorCodes.EXECUTION_FAILURE })
  }
}

export class RuntimeInvalidInputError extends RuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: RuntimeErrorCodes.INVALID_INPUT })
  }
}

export class RuntimeAbortedError extends RuntimeError {
  constructor(message, options = {}) {
    super(message, { ...options, code: RuntimeErrorCodes.ABORTED })
  }
}
