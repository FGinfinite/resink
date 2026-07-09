import { ObjectId } from '../../../app/js/mongodb.js'
import { expect } from 'chai'

import * as AISessionHelper from './helpers/AISession.js'
import * as AIWritingAgentApp from './helpers/AIWritingAgentApp.js'

describe('Messaging', function () {
  before(async function () {
    await AIWritingAgentApp.ensureRunning()
  })

  afterEach(async function () {
    AIWritingAgentApp.resetFetchHandler()
    await cleanupAcceptanceModelConfig()
  })

  async function seedModelConfig() {
    await cleanupAcceptanceModelConfig()
    const configId = new ObjectId()
    await AIWritingAgentApp.db.aiModelConfigs.insertOne({
      _id: configId,
      name: 'Acceptance Fake Model',
      provider: 'openai-compatible',
      apiBase: 'http://fake-llm.test/v1',
      apiKey: 'test-key',
      model: 'fake-tool-model',
      enabled: true,
      supportsImage: false,
      maxTokens: 1024,
      temperature: 0,
      retryAttempts: 1,
      retryDelay: 1,
      maxRetryTimeMs: 5000,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await AIWritingAgentApp.db.aiModelSlots.updateOne(
      { slug: 'acceptance' },
      {
        $set: {
          slug: 'acceptance',
          label: 'Acceptance',
          modelConfigId: configId,
          enabled: true,
          sortOrder: 1,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    )
  }

  async function cleanupAcceptanceModelConfig() {
    const slots = await AIWritingAgentApp.db.aiModelSlots
      .find({ slug: 'acceptance' })
      .project({ _id: 1, modelConfigId: 1 })
      .toArray()
    if (slots.length === 0) return

    await AIWritingAgentApp.db.aiModelSlots.deleteMany({ slug: 'acceptance' })
    const modelConfigIds = slots
      .map(slot => slot.modelConfigId)
      .filter(Boolean)
    if (modelConfigIds.length > 0) {
      await AIWritingAgentApp.db.aiModelConfigs.deleteMany({
        _id: { $in: modelConfigIds },
      })
    }
  }

  function streamResponse(chunks) {
    const payload = chunks
      .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('') + 'data: [DONE]\n\n'
    const bytes = new TextEncoder().encode(payload)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      }),
    }
  }

  describe('POST /api/ai/sessions/:id/messages', function () {
    it('should return 400 when content is missing', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)

      const { response } = await AISessionHelper.sendMessage(
        createBody.session.id,
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
      await AISessionHelper.deleteSession(createBody.session.id)

      // Try to send message
      const { response } = await AISessionHelper.sendMessage(
        createBody.session.id,
        'Hello'
      )
      expect(response.statusCode).to.equal(410)
    })

    it('should persist diagnostic tool calls created during sendMessage', async function () {
      await seedModelConfig()
      const projectId = new ObjectId().toString()
      const docId = new ObjectId().toString()
      let llmCallCount = 0

      AIWritingAgentApp.setFetchHandler(async (url, options, { ok, notFound }) => {
        const requestUrl = String(url)

        if (requestUrl.includes('/chat/completions')) {
          llmCallCount += 1
          if (llmCallCount === 1) {
            return streamResponse([
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-list-files-1',
                          type: 'function',
                          function: {
                            name: 'list_files',
                            arguments: '{"type":"docs"}',
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
              },
            ])
          }
          return streamResponse([
            {
              choices: [
                {
                  delta: { content: 'Found main.tex.' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 15, completion_tokens: 4, total_tokens: 19 },
            },
          ])
        }

        if (requestUrl.includes(`/internal/project/${projectId}/membership/`)) {
          return ok()
        }

        if (requestUrl.includes(`/internal/project/${projectId}/entities`)) {
          return ok({
            docs: [{ id: docId, path: '/main.tex', name: 'main.tex' }],
            files: [],
          })
        }

        if (requestUrl.includes(`/project/${projectId}/doc/${docId}`)) {
          return ok({
            lines: ['\\\\documentclass{article}', '\\\\begin{document}', 'Hi', '\\\\end{document}'],
            version: 1,
          })
        }

        return notFound()
      })

      const { body: createBody } =
        await AISessionHelper.createSession(projectId)
      const { response } = await AISessionHelper.sendMessage(
        createBody.session.id,
        'List project files',
        { stream: false, modelSlot: 'acceptance' }
      )
      expect(response.statusCode).to.equal(200)

      const { response: getResponse, body } = await AISessionHelper.getSession(
        createBody.session.id
      )
      expect(getResponse.statusCode).to.equal(200)
      expect(body.session.messages).to.have.length(2)
      expect(body.session.messages[1]).to.include({
        role: 'assistant',
        content: 'Found main.tex.',
      })
      expect(body.session.toolCalls).to.have.length(1)
      expect(body.session.toolCalls[0]).to.include({
        id: 'call-list-files-1',
        tool: 'list_files',
        status: 'completed',
      })
      expect(body.session.toolCalls[0].arguments).to.deep.equal({ type: 'docs' })
      expect(body.session.toolCalls[0].resultSummary).to.include('Workspace files')
    })
  })

  describe('GET /api/ai/sessions/:id message replay', function () {
    it('should return persisted messages and diagnostic tool calls', async function () {
      const projectId = new ObjectId().toString()
      const { body: createBody } =
        await AISessionHelper.createSession(projectId)
      const sessionObjectId = new ObjectId(createBody.session.id)
      const now = new Date()

      await AIWritingAgentApp.db.aiMessages.insertMany([
        {
          sessionId: sessionObjectId,
          seq: 1,
          role: 'user',
          content: 'Read main.tex',
          timestamp: now,
        },
        {
          sessionId: sessionObjectId,
          seq: 2,
          role: 'assistant',
          content: 'I read main.tex.',
          contentBlocks: [
            { type: 'thinking', content: 'hidden reasoning' },
            {
              type: 'tool_call',
              entry: {
                id: 'tc-read-1',
                tool: 'read_document',
                arguments: { path: 'main.tex' },
                status: 'completed',
              },
            },
            { type: 'text', content: 'I read main.tex.' },
          ],
          timestamp: now,
        },
        {
          sessionId: sessionObjectId,
          seq: 3,
          role: 'assistant',
          content: 'The turn failed.',
          status: 'failed',
          error: {
            message: 'Model request failed',
            code: 'LLM_ERROR',
          },
          timestamp: now,
        },
      ])
      await AIWritingAgentApp.db.aiSessions.updateOne(
        { _id: sessionObjectId },
        { $set: { _nextSeq: 4, updatedAt: now, lastTurnAt: now } }
      )
      await AIWritingAgentApp.db.aiAgentToolCalls.insertOne({
        sessionId: sessionObjectId,
        messageId: 'assistant-message-1',
        toolCallId: 'tc-read-1',
        name: 'read_document',
        arguments: { path: 'main.tex' },
        status: 'completed',
        resultSummary: 'Read main.tex',
        durationMs: 12,
        error: null,
        relatedChangeIds: [],
        relatedArtifactIds: [],
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        updatedAt: now,
      })

      const { response, body } = await AISessionHelper.getSession(
        createBody.session.id
      )

      expect(response.statusCode).to.equal(200)
      expect(body.session.messages).to.have.length(3)
      expect(body.session.messages[0]).to.include({
        role: 'user',
        content: 'Read main.tex',
      })
      expect(body.session.messages[1].contentBlocks).to.have.length(2)
      expect(body.session.messages[1].contentBlocks[0].entry).to.include({
        id: 'tc-read-1',
        tool: 'read_document',
        status: 'completed',
      })
      expect(body.session.messages[1].contentBlocks.some(block => block.type === 'thinking')).to.equal(false)
      expect(body.session.messages[2]).to.deep.include({
        role: 'assistant',
        content: 'The turn failed.',
        status: 'failed',
        error: {
          message: 'Model request failed',
          code: 'LLM_ERROR',
        },
      })
      expect(body.session.toolCalls).to.deep.include({
        id: 'tc-read-1',
        messageId: 'assistant-message-1',
        tool: 'read_document',
        arguments: { path: 'main.tex' },
        status: 'completed',
        resultSummary: 'Read main.tex',
        durationMs: 12,
        error: null,
        relatedChangeIds: [],
        relatedArtifactIds: [],
        createdAt: now.getTime(),
        startedAt: now.getTime(),
        finishedAt: now.getTime(),
      })
    })
  })
})
