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

const agentHandlers = {
  getAgentInstructions: handler('getAgentInstructions'),
  createAgentInstructions: handler('createAgentInstructions'),
  saveAgentInstructionsDraft: handler('saveAgentInstructionsDraft'),
  listMemories: handler('listMemories'),
  createMemory: handler('createMemory'),
  updateMemory: handler('updateMemory'),
  deleteMemory: handler('deleteMemory'),
  listMemorySuggestions: handler('listMemorySuggestions'),
  acceptMemorySuggestion: handler('acceptMemorySuggestion'),
  dismissMemorySuggestion: handler('dismissMemorySuggestion'),
  getContextSnapshot: handler('getContextSnapshot'),
  getSessionSummary: handler('getSessionSummary'),
}

vi.mock('../../../app/js/AgentController.js', () => ({
  default: new Proxy(agentHandlers, { get: (target, prop) => target[prop] || handler('agent') }),
}))

vi.mock('../../../app/js/SandboxAgentController.js', () => ({
  default: new Proxy({}, { get: () => handler('sandbox') }),
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

const PROJECT_ID = '0123456789abcdef01234567'
const USER_ID = 'abcdefabcdefabcdefabcdef'
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
      ...headers,
    },
  })
  return {
    status: response.status,
    body: await response.json(),
  }
}

describe('Router Agent Context routes', () => {
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

  it('requires user identity for Project Instructions routes', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${PROJECT_ID}/agent-instructions`],
      ['POST', `/projects/${PROJECT_ID}/agent-instructions/create`],
      ['PUT', `/projects/${PROJECT_ID}/agent-instructions/draft`],
      ['GET', '/memories'],
      ['POST', '/memories'],
      ['PATCH', '/memories/abcdefabcdefabcdefabcdef'],
      ['DELETE', '/memories/abcdefabcdefabcdefabcdef'],
      ['GET', '/memory-suggestions'],
      ['POST', '/memory-suggestions/abcdefabcdefabcdefabcdef/accept'],
      ['POST', '/memory-suggestions/abcdefabcdefabcdefabcdef/dismiss'],
      ['GET', '/sessions/abcdefabcdefabcdefabcdef/context-snapshot/turn-1'],
      ['GET', '/sessions/abcdefabcdefabcdefabcdef/session-summary'],
    ]) {
      const response = await requestJson(server, method, path)
      expect(response).toEqual({
        status: 401,
        body: { error: 'Authentication required' },
      })
    }
  })

  it('routes Project Instructions requests to AgentController handlers', async () => {
    const userHeaders = {
      'x-user-id': USER_ID,
      'x-user-sig': USER_SIG,
    }

    const getResponse = await requestJson(
      server,
      'GET',
      `/projects/${PROJECT_ID}/agent-instructions`,
      userHeaders
    )
    const createResponse = await requestJson(
      server,
      'POST',
      `/projects/${PROJECT_ID}/agent-instructions/create`,
      userHeaders
    )
    const draftResponse = await requestJson(
      server,
      'PUT',
      `/projects/${PROJECT_ID}/agent-instructions/draft`,
      userHeaders
    )

    expect(getResponse).toEqual({
      status: 200,
      body: { handler: 'getAgentInstructions' },
    })
    expect(createResponse).toEqual({
      status: 200,
      body: { handler: 'createAgentInstructions' },
    })
    expect(draftResponse).toEqual({
      status: 200,
      body: { handler: 'saveAgentInstructionsDraft' },
    })
    expect(agentHandlers.getAgentInstructions).toHaveBeenCalledOnce()
    expect(agentHandlers.createAgentInstructions).toHaveBeenCalledOnce()
    expect(agentHandlers.saveAgentInstructionsDraft).toHaveBeenCalledOnce()
  })

  it('routes Memories and Trace requests to AgentController handlers', async () => {
    const userHeaders = {
      'x-user-id': USER_ID,
      'x-user-sig': USER_SIG,
    }

    const routes = [
      ['GET', '/memories', 'listMemories'],
      ['POST', '/memories', 'createMemory'],
      ['PATCH', '/memories/abcdefabcdefabcdefabcdef', 'updateMemory'],
      ['DELETE', '/memories/abcdefabcdefabcdefabcdef', 'deleteMemory'],
      ['GET', '/memory-suggestions', 'listMemorySuggestions'],
      ['POST', '/memory-suggestions/abcdefabcdefabcdefabcdef/accept', 'acceptMemorySuggestion'],
      ['POST', '/memory-suggestions/abcdefabcdefabcdefabcdef/dismiss', 'dismissMemorySuggestion'],
      ['GET', '/sessions/abcdefabcdefabcdefabcdef/context-snapshot/turn-1', 'getContextSnapshot'],
      ['GET', '/sessions/abcdefabcdefabcdefabcdef/session-summary', 'getSessionSummary'],
    ]

    for (const [method, path, handlerName] of routes) {
      const response = await requestJson(server, method, path, userHeaders)
      expect(response).toEqual({
        status: 200,
        body: { handler: handlerName },
      })
      expect(agentHandlers[handlerName]).toHaveBeenCalledOnce()
    }
  })
})
