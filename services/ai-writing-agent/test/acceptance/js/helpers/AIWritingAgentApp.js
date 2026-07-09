import { createServer } from '../../../../app/js/server.js'
import { promisify } from 'node:util'
import Settings from '@overleaf/settings'

export { db } from '../../../../app/js/mongodb.js'

let serverPromise = null
let fetchHandler = null

class FakeResponse {
  constructor(body = null, options = {}) {
    this.status = options.status || 200
    this.ok = this.status >= 200 && this.status < 300
    this.headers = {
      get: () => null,
    }
    this.body = { cancel() {} }
    this._body = body
  }

  async json() {
    return this._body
  }

  async text() {
    return typeof this._body === 'string'
      ? this._body
      : JSON.stringify(this._body || {})
  }
}

export function setFetchHandler(handler) {
  fetchHandler = handler
}

export function resetFetchHandler() {
  fetchHandler = null
}

function ok(body = {}) {
  return new FakeResponse(body)
}

function notFound(body = { error: 'not found' }) {
  return new FakeResponse(body, { status: 404 })
}

async function defaultFakeFetch(url, options = {}) {
  if (fetchHandler) {
    const response = await fetchHandler(url, options, { ok, notFound, FakeResponse })
    if (response) return response
  }
  return ok()
}

export async function ensureRunning() {
  if (!serverPromise) {
    Settings.internal.allowProxySecretBypass = true
    global.fetch = defaultFakeFetch
    const { app } = await createServer()
    const startServer = promisify(app.listen.bind(app))
    serverPromise = startServer(3060, '127.0.0.1')
  }
  return serverPromise
}
