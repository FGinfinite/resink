import { ObjectId } from '../../../../app/js/mongodb.js'
import { expect } from 'chai'

import * as AISessionHelper from './helpers/AISession.js'
import * as AIWritingAgentApp from './helpers/AIWritingAgentApp.js'

describe('Session Management', function () {
  before(async function () {
    await AIWritingAgentApp.ensureRunning()
  })

  describe('POST /api/ai/sessions', function () {
    it('should create a new session', async function () {
      const projectId = new ObjectId().toString()
      const { response, body } = await AISessionHelper.createSession(projectId)

      expect(response.statusCode).to.equal(201)
      expect(body.sessionId).to.be.a('string')
      expect(body.projectId).to.equal(projectId)
      expect(body.status).to.equal('active')
    })

    it('should create a session with docId', async function () {
      const projectId = new ObjectId().toString()
      const docId = new ObjectId().toString()
      const { response, body } = await AISessionHelper.createSession(
        projectId,
        docId
      )

      expect(response.statusCode).to.equal(201)
      expect(body.sessionId).to.be.a('string')
    })

    it('should return 400 when projectId is missing', async function () {
      const { response } = await AISessionHelper.createSession(null)
      expect(response.statusCode).to.equal(400)
    })
  })

  describe('GET /api/ai/sessions/:id', function () {
    it('should get session status', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response, body } = await AISessionHelper.getSession(
        createBody.sessionId
      )

      expect(response.statusCode).to.equal(200)
      expect(body.sessionId).to.equal(createBody.sessionId)
      expect(body.projectId).to.equal(projectId)
      expect(body.status).to.equal('active')
      expect(body.messageCount).to.equal(0)
    })

    it('should return 404 for non-existent session', async function () {
      const fakeId = new ObjectId().toString()
      const { response } = await AISessionHelper.getSession(fakeId)
      expect(response.statusCode).to.equal(404)
    })

    it('should return 400 for invalid session ID', async function () {
      const { response } = await AISessionHelper.getSession('invalid-id')
      expect(response.statusCode).to.equal(400)
    })
  })

  describe('DELETE /api/ai/sessions/:id', function () {
    it('should end a session', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response } = await AISessionHelper.deleteSession(
        createBody.sessionId
      )
      expect(response.statusCode).to.equal(204)

      // Verify session is ended
      const { response: getResp } = await AISessionHelper.getSession(
        createBody.sessionId
      )
      expect(getResp.statusCode).to.equal(410) // Gone - session expired
    })

    it('should return 404 for non-existent session', async function () {
      const fakeId = new ObjectId().toString()
      const { response } = await AISessionHelper.deleteSession(fakeId)
      expect(response.statusCode).to.equal(404)
    })
  })
})
