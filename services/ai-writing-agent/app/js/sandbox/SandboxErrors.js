export class SandboxError extends Error {
  constructor(message, info = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = info.code || 'SANDBOX_ERROR'
    this.info = info
  }
}

export class SandboxNotFoundError extends SandboxError {
  constructor(sessionId) {
    super('Sandbox session not found', {
      code: 'SANDBOX_NOT_FOUND',
      sessionId,
    })
  }
}

export class SandboxPathError extends SandboxError {
  constructor(path, reason) {
    super('Sandbox path is outside the workspace scope', {
      code: 'SANDBOX_PATH_ERROR',
      path,
      reason,
    })
  }
}

export class SandboxCommandError extends SandboxError {
  constructor(message, info = {}) {
    super(message, {
      code: 'SANDBOX_COMMAND_ERROR',
      ...info,
    })
  }
}

export class SandboxTimeoutError extends SandboxCommandError {
  constructor(timeoutMs, info = {}) {
    super('Sandbox command timed out', {
      code: 'SANDBOX_TIMEOUT',
      timeoutMs,
      ...info,
    })
  }
}

export class SandboxOutputLimitError extends SandboxCommandError {
  constructor(maxOutputBytes, info = {}) {
    super('Sandbox command exceeded max output bytes', {
      code: 'SANDBOX_OUTPUT_LIMIT',
      maxOutputBytes,
      ...info,
    })
  }
}

export class SandboxSetupError extends SandboxError {
  constructor(message, info = {}) {
    super(message, {
      code: 'SANDBOX_SETUP_ERROR',
      ...info,
    })
  }
}

export class SandboxPolicyError extends SandboxError {
  constructor(message, info = {}) {
    super(message, {
      code: 'SANDBOX_POLICY_ERROR',
      ...info,
    })
  }
}

export default {
  SandboxError,
  SandboxNotFoundError,
  SandboxPathError,
  SandboxCommandError,
  SandboxTimeoutError,
  SandboxOutputLimitError,
  SandboxSetupError,
  SandboxPolicyError,
}
