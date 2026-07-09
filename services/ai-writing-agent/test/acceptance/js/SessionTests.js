import { ObjectId } from '../../../app/js/mongodb.js'
import { expect } from 'chai'
import settings from '@overleaf/settings'

import * as AISessionHelper from './helpers/AISession.js'
import * as AIWritingAgentApp from './helpers/AIWritingAgentApp.js'

function withTemporaryAgentRuntime(overrides, fn) {
  const original = {
    runtimeMode: settings.aiAssistant?.runtimeMode,
    agentRuntime: settings.aiAssistant?.agentRuntime,
  }
  settings.aiAssistant = {
    ...(settings.aiAssistant || {}),
    ...overrides,
    agentRuntime: {
      ...(settings.aiAssistant?.agentRuntime || {}),
      ...(overrides.agentRuntime || {}),
      agentLoopV2: {
        ...(settings.aiAssistant?.agentRuntime?.agentLoopV2 || {}),
        ...(overrides.agentRuntime?.agentLoopV2 || {}),
      },
    },
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      settings.aiAssistant.runtimeMode = original.runtimeMode
      settings.aiAssistant.agentRuntime = original.agentRuntime
    })
}

describe('Session Management', function () {
  before(async function () {
    await AIWritingAgentApp.ensureRunning()
  })

  describe('POST /api/ai/sessions', function () {
    it('should create a new session', async function () {
      const projectId = new ObjectId().toString()
      const { response, body } = await AISessionHelper.createSession(projectId)

      expect(response.statusCode).to.equal(201)
      expect(body.session.id).to.be.a('string')
      expect(body.session.projectId).to.equal(projectId)
      expect(body.session.userId).to.equal(AISessionHelper.DEFAULT_USER_ID)
      expect(body.session.profile).to.equal('default')
      expect(body.session.runtimeMode).to.be.oneOf([
        'legacy',
        'sandbox-v0',
        'agent-loop-v2',
      ])
      expect(body.session.status).to.equal('active')
      expect(body.session.parentSessionId).to.equal(null)
      expect(body.session.workspaceId).to.equal(null)
      expect(body.session.expiresAt).to.be.a('number')
    })

    it('should default new sessions to AgentLoopV2 when dependencies are configured', async function () {
      await withTemporaryAgentRuntime(
        {
          runtimeMode: 'auto',
          agentRuntime: {
            agentLoopV2: {
              enabled: true,
              apiBase: 'https://api.deepseek.com/v1',
              model: 'deepseek-v4-flash',
            },
          },
        },
        async () => {
          const projectId = new ObjectId().toString()
          const { response, body } =
            await AISessionHelper.createSession(projectId)

          expect(response.statusCode).to.equal(201)
          expect(body.session.runtimeMode).to.equal('agent-loop-v2')
        }
      )
    })

    it('should create a session with docId', async function () {
      const projectId = new ObjectId().toString()
      const docId = new ObjectId().toString()
      const { response, body } = await AISessionHelper.createSession(
        projectId,
        docId
      )

      expect(response.statusCode).to.equal(201)
      expect(body.session.id).to.be.a('string')
    })

    it('should persist requested AgentLoopV2 session metadata', async function () {
      const projectId = new ObjectId().toString()
      const { response, body } = await AISessionHelper.createSession(projectId, null, {
        profile: 'paper-reviewer',
        runtimeMode: 'agent-loop-v2',
        model: 'deepseek-v4-flash',
      })

      expect(response.statusCode).to.equal(201)
      expect(body.session.profile).to.equal('paper-reviewer')
      expect(body.session.runtimeMode).to.equal('agent-loop-v2')
      expect(body.session.model).to.equal('deepseek-v4-flash')
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
        createBody.session.id
      )

      expect(response.statusCode).to.equal(200)
      expect(body.session.id).to.equal(createBody.session.id)
      expect(body.session.projectId).to.equal(projectId)
      expect(body.session.status).to.equal('active')
      expect(body.session.messages).to.deep.equal([])
    })

    it('should hydrate pending workspace changes, artifacts, and drift metadata', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)
      const sessionObjectId = new ObjectId(createBody.session.id)
      const workspaceId = `workspace-${createBody.session.id}`
      const artifactId = `artifact-${createBody.session.id}`

      await AIWritingAgentApp.db.aiSessions.updateOne(
        { _id: sessionObjectId },
        {
          $set: {
            workspaceId,
            workspaceStatus: 'pending-review',
            pendingChanges: [
              {
                id: 'change-1',
                projectId,
                type: 'edit',
                path: '/main.tex',
                status: 'pending',
                createdAt: Date.now(),
                workspaceId,
              },
            ],
          },
        }
      )
      await AIWritingAgentApp.db.aiAgentWorkspaces.insertOne({
        _id: workspaceId,
        sessionId: createBody.session.id,
        projectId,
        userId: AISessionHelper.DEFAULT_USER_ID,
        status: 'ready',
        lastDrift: {
          hasDrift: true,
          changes: [{ type: 'version-mismatch', path: '/main.tex' }],
        },
        updatedAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })
      await AIWritingAgentApp.db.aiSandboxArtifacts.insertOne({
        _id: artifactId,
        sessionId: createBody.session.id,
        path: 'output.pdf',
        size: 2048,
        content: Buffer.from('%PDF'),
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60000),
      })

      const { response, body } = await AISessionHelper.getSession(
        createBody.session.id
      )

      expect(response.statusCode).to.equal(200)
      expect(body.session.workspaceId).to.equal(workspaceId)
      expect(body.session.workspaceStatus).to.equal('ready')
      expect(body.session.pendingChanges).to.have.length(1)
      expect(body.session.pendingChanges[0].id).to.equal('change-1')
      expect(body.session.artifacts).to.deep.include({
        id: artifactId,
        path: 'output.pdf',
        size: 2048,
      })
      expect(body.session.workspaceDrift.hasDrift).to.equal(true)
    })

    it('should reject access by another user', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response } = await AISessionHelper.getSession(
        createBody.session.id,
        { userId: AISessionHelper.OTHER_USER_ID }
      )

      expect(response.statusCode).to.equal(403)
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

  describe('GET /api/ai/sessions', function () {
    it('should list active sessions for the project and user', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response, body } = await AISessionHelper.listSessions(projectId)

      expect(response.statusCode).to.equal(200)
      expect(body.sessions.map(session => session.id)).to.include(
        createBody.session.id
      )
      expect(body.sessions[0].status).to.equal('active')
    })
  })

  describe('DELETE /api/ai/sessions/:id', function () {
    it('should archive a session', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response } = await AISessionHelper.deleteSession(
        createBody.session.id
      )
      expect(response.statusCode).to.equal(204)

      const { response: listResp, body: listBody } =
        await AISessionHelper.listSessions(projectId)
      expect(listResp.statusCode).to.equal(200)
      expect(listBody.sessions.map(session => session.id)).not.to.include(
        createBody.session.id
      )

      // Verify archived session can no longer be resumed
      const { response: getResp } = await AISessionHelper.getSession(
        createBody.session.id
      )
      expect(getResp.statusCode).to.equal(410)
    })

    it('should return 404 for non-existent session', async function () {
      const fakeId = new ObjectId().toString()
      const { response } = await AISessionHelper.deleteSession(fakeId)
      expect(response.statusCode).to.equal(404)
    })
  })
})
