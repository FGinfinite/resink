import express from 'express'
import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@overleaf/settings', () => ({
  default: {
    aiAssistant: {},
    image: {},
    internal: { proxySecret: 'test-proxy-secret' },
  },
}))

vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    log: vi.fn(),
  },
}))

function handler(name) {
  return vi.fn((_req, res) => res.json({ handler: name }))
}

const sandboxHandlers = {
  startSession: handler('startSession'),
  createWorkspace: handler('createWorkspace'),
  getWorkspace: handler('getWorkspace'),
  stopSession: handler('stopSession'),
  acceptChange: handler('acceptChange'),
  rejectChange: handler('rejectChange'),
  getArtifact: handler('getArtifact'),
  cleanupSandbox: handler('cleanupSandbox'),
}

vi.mock('../../../app/js/SandboxAgentController.js', () => ({
  default: sandboxHandlers,
}))

vi.mock('../../../app/js/AgentController.js', () => ({
  default: new Proxy({}, { get: () => handler('agent') }),
}))

vi.mock('../../../app/js/QuickEditController.js', () => ({
  default: { quickEdit: handler('quickEdit') },
}))

vi.mock('../../../app/js/AutocompleteController.js', () => ({
  default: {
    complete: handler('complete'),
    streamComplete: handler('streamComplete'),
  },
}))

vi.mock('../../../app/js/ModelConfigController.js', () => ({
  default: new Proxy({}, { get: () => handler('modelConfig') }),
}))

vi.mock('../../../app/js/PythonDependencyController.js', () => ({
  default: new Proxy({}, { get: () => handler('pythonDependency') }),
}))

vi.mock('../../../app/js/RuntimeConfigManager.js', () => ({
  getAgentRuntimeStatus: () => ({ ok: true }),
}))

const { createRouter } = await import('../../../app/js/Router.js')

const USER_ID = '0123456789abcdef01234567'
const USER_SIG = crypto
  .createHmac('sha256', 'test-proxy-secret')
  .update(USER_ID)
  .digest('hex')

async function requestJson(server, method, path, headers = {}) {
  const address = server.address()
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-ai-proxy-secret': 'test-proxy-secret',
      'x-user-id': USER_ID,
      'x-user-sig': USER_SIG,
      ...headers,
    },
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

describe('Router admin guard', () => {
  let server

  beforeEach(async () => {
    vi.clearAllMocks()
    const app = express()
    app.use(express.json())
    app.use(createRouter())
    server = await new Promise(resolve => {
      const instance = app.listen(0, () => resolve(instance))
    })
  })

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('rejects non-admin browser users before sandbox-v0 handlers run', async () => {
    for (const [method, path] of [
      ['POST', '/sandbox/sessions'],
      ['POST', '/sandbox/workspaces'],
      ['GET', '/sandbox/workspaces/workspace-1'],
      ['POST', '/sandbox/sessions/session-1/stop'],
      ['POST', '/sandbox/sessions/session-1/changes/change-1/accept'],
      ['POST', '/sandbox/sessions/session-1/changes/change-1/reject'],
      ['GET', '/sandbox/sessions/session-1/artifacts/artifact-1'],
      ['POST', '/admin/sandbox/cleanup'],
      ['GET', '/admin/python/dependency-requests'],
      ['GET', '/admin/python/dependency-requests/0123456789abcdef01234567'],
      ['POST', '/admin/python/dependency-requests/0123456789abcdef01234567/approve'],
      ['POST', '/admin/python/dependency-requests/0123456789abcdef01234567/deny'],
    ]) {
      const response = await requestJson(server, method, path)
      expect(response).toEqual({
        status: 403,
        body: { error: 'Admin access required' },
      })
    }

    for (const fn of Object.values(sandboxHandlers)) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('allows admin users through the sandbox-v0 guard', async () => {
    const response = await requestJson(server, 'POST', '/sandbox/sessions', {
      'x-user-is-admin': 'true',
    })

    expect(response).toEqual({
      status: 200,
      body: { handler: 'startSession' },
    })
    expect(sandboxHandlers.startSession).toHaveBeenCalledOnce()
  })

  it('allows non-admin project-scoped dependency approval routes through to controller', async () => {
    for (const action of ['approve', 'deny']) {
      const response = await requestJson(
        server,
        'POST',
        `/projects/0123456789abcdef01234567/python/dependency-requests/abcdefabcdefabcdefabcdef/${action}`
      )

      expect(response).toEqual({
        status: 200,
        body: { handler: 'pythonDependency' },
      })
    }
  })

  it('allows non-admin session-scoped team run routes through to controller', async () => {
    const sessionId = '0123456789abcdef01234567'
    const teamId = 'abcdefabcdefabcdefabcdef'
    const taskId = 'fedcbafedcbafedcbafedcba'
    for (const [method, path] of [
      ['GET', `/sessions/${sessionId}/team-runs`],
      ['GET', `/sessions/${sessionId}/team-runs/${teamId}`],
      ['POST', `/sessions/${sessionId}/team-runs/${teamId}/cancel`],
      ['POST', `/sessions/${sessionId}/team-runs/${teamId}/tasks/${taskId}/retry`],
    ]) {
      const response = await requestJson(server, method, path)
      expect(response).toEqual({
        status: 200,
        body: { handler: 'agent' },
      })
    }
  })
})
