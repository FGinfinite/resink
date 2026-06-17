import { ObjectId } from '../../../../app/js/mongodb.js'
import { expect } from 'chai'

import * as AISessionHelper from './helpers/AISession.js'
import * as AIWritingAgentApp from './helpers/AIWritingAgentApp.js'

describe('Messaging', function () {
  before(async function () {
    await AIWritingAgentApp.ensureRunning()
  })

  describe('POST /api/ai/sessions/:id/messages', function () {
    it('should return 400 when content is missing', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response } = await AISessionHelper.sendMessage(
        createBody.sessionId,
        null
      )
      expect(response.statusCode).to.equal(400)
    })

    it('should return 404 for non-existent session', async function () {
      const fakeId = new ObjectId().toString()
      const { response } = await AISessionHelper.sendMessage(
        fakeId,
        'Hello'
      )
      expect(response.statusCode).to.equal(404)
    })

    it('should return 410 for ended session', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      // End the session
      await AISessionHelper.deleteSession(createBody.sessionId)

      // Try to send message
      const { response } = await AISessionHelper.sendMessage(
        createBody.sessionId,
        'Hello'
      )
      expect(response.statusCode).to.equal(410)
    })
  })
})
