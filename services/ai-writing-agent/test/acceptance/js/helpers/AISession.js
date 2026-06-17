import Request from 'request'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3060'

const request = Request.defaults({
  baseUrl: DEFAULT_BASE_URL,
})

/**
 * Helper for making AI session API requests
 */
export class AISession {
  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = baseUrl
    this.sessionId = null
    this.request = Request.defaults({ baseUrl })
  }

  /**
   * Make an async request
   */
  async _request(options) {
    return new Promise((resolve, reject) => {
      this.request(options, (err, response, body) => {
        if (err) {
          reject(err)
        } else {
          resolve({ response, body })
        }
      })
    })
  }

  /**
   * Create a new session
   */
  async create(projectId, docId = null) {
    const { response, body } = await this._request({
      method: 'post',
      url: '/api/ai/sessions',
      json: { projectId, docId },
    })

    if (response.statusCode === 201 && body.sessionId) {
      this.sessionId = body.sessionId
    }

    return { response, body }
  }

  /**
   * Get session status
   */
  async get(sessionId = null) {
    const id = sessionId || this.sessionId
    return this._request({
      method: 'get',
      url: `/api/ai/sessions/${id}`,
      json: true,
    })
  }

  /**
   * Delete session
   */
  async delete(sessionId = null) {
    const id = sessionId || this.sessionId
    return this._request({
      method: 'delete',
      url: `/api/ai/sessions/${id}`,
    })
  }

  /**
   * Send a message
   */
  async sendMessage(content, options = {}) {
    const { context, stream } = options
    return this._request({
      method: 'post',
      url: `/api/ai/sessions/${this.sessionId}/messages`,
      json: { content, context, stream },
    })
  }

  /**
   * Accept a change
   */
  async acceptChange(changeId) {
    return this._request({
      method: 'post',
      url: `/api/ai/sessions/${this.sessionId}/changes/${changeId}/accept`,
      json: true,
    })
  }

  /**
   * Reject a change
   */
  async rejectChange(changeId) {
    return this._request({
      method: 'post',
      url: `/api/ai/sessions/${this.sessionId}/changes/${changeId}/reject`,
      json: true,
    })
  }

  /**
   * Accept all changes
   */
  async acceptAllChanges() {
    return this._request({
      method: 'post',
      url: `/api/ai/sessions/${this.sessionId}/changes/accept-all`,
      json: true,
    })
  }

  /**
   * Reject all changes
   */
  async rejectAllChanges() {
    return this._request({
      method: 'post',
      url: `/api/ai/sessions/${this.sessionId}/changes/reject-all`,
      json: true,
    })
  }
}

// Standalone functions for simpler usage
export async function createSession(projectId, docId = null) {
  return new Promise((resolve, reject) => {
    request(
      {
        method: 'post',
        url: '/api/ai/sessions',
        json: { projectId, docId },
      },
      (err, response, body) => {
        if (err) reject(err)
        else resolve({ response, body })
      }
    )
  })
}

export async function getSession(sessionId) {
  return new Promise((resolve, reject) => {
    request(
      {
        method: 'get',
        url: `/api/ai/sessions/${sessionId}`,
        json: true,
      },
      (err, response, body) => {
        if (err) reject(err)
        else resolve({ response, body })
      }
    )
  })
}

export async function deleteSession(sessionId) {
  return new Promise((resolve, reject) => {
    request(
      {
        method: 'delete',
        url: `/api/ai/sessions/${sessionId}`,
      },
      (err, response, body) => {
        if (err) reject(err)
        else resolve({ response, body })
      }
    )
  })
}

export async function sendMessage(sessionId, content, options = {}) {
  return new Promise((resolve, reject) => {
    request(
      {
        method: 'post',
        url: `/api/ai/sessions/${sessionId}/messages`,
        json: { content, ...options },
      },
      (err, response, body) => {
        if (err) reject(err)
        else resolve({ response, body })
      }
    )
  })
}

export default AISession
