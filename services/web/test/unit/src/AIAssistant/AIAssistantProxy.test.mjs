import crypto from 'node:crypto'
import { expect, vi } from 'vitest'

const modulePath = '../../../../app/src/Features/AIAssistant/AIAssistantProxy.mjs'

describe('AIAssistantProxy', function () {
  beforeEach(async function (ctx) {
    ctx.proxyMiddleware = vi.fn()
    ctx.fixRequestBody = vi.fn()

    vi.doMock('http-proxy-middleware', () => ({
      createProxyMiddleware: vi.fn(options => {
        ctx.proxyOptions = options
        return ctx.proxyMiddleware
      }),
      fixRequestBody: ctx.fixRequestBody,
    }))

    vi.doMock('@overleaf/settings', () => ({
      default: (ctx.settings = {
        aiAssistantUrl: 'http://ai-service:3060/api/ai',
        aiAssistant: {
          proxySecret: 'proxy-secret',
          allowedHosts: ['ai-service'],
          sseTimeoutMs: 2400000,
          proxyTimeoutMs: 60000,
        },
      }),
    }))

    vi.doMock(
      '../../../../app/src/Features/Authentication/SessionManager.mjs',
      () => ({
        default: {
          getLoggedInUserId: vi.fn(() => '0123456789abcdef01234567'),
        },
      })
    )

    const { default: AIAssistantProxy } = await import(modulePath)
    ctx.proxy = AIAssistantProxy.createProxy()
  })

  it('should proxy to the service base URL and restore the mounted /api/ai path', function (ctx) {
    expect(ctx.proxy).to.equal(ctx.proxyMiddleware)
    expect(ctx.proxyOptions.target).to.equal('http://ai-service:3060')
    expect(ctx.proxyOptions.pathRewrite('/sessions')).to.equal(
      '/api/ai/sessions'
    )
    expect(ctx.proxyOptions.pathRewrite('/chat/stream')).to.equal(
      '/api/ai/chat/stream'
    )
  })

  it('should strip forged AI trust headers before injecting session headers', function (ctx) {
    const removedHeaders = []
    const setHeaders = {}
    const proxyReq = {
      removeHeader: vi.fn(header => removedHeaders.push(header)),
      setHeader: vi.fn((header, value) => {
        setHeaders[header] = value
      }),
      setTimeout: vi.fn(),
    }
    const req = {
      headers: {
        accept: 'application/json',
        'x-user-id': 'attacker',
        'x-user-sig': 'bad-signature',
        'x-user-is-admin': 'true',
        'x-ai-proxy-secret': 'bad-secret',
      },
      session: {},
      setTimeout: vi.fn(),
    }
    const res = {}

    ctx.proxyOptions.onProxyReq(proxyReq, req, res)

    expect(removedHeaders).to.include.members([
      'cookie',
      'authorization',
      'x-user-id',
      'x-user-sig',
      'x-user-is-admin',
      'x-ai-proxy-secret',
    ])
    expect(setHeaders['x-user-id']).to.equal('0123456789abcdef01234567')
    expect(setHeaders['x-ai-proxy-secret']).to.equal('proxy-secret')
    expect(setHeaders['x-user-sig']).to.equal(
      crypto
        .createHmac('sha256', 'proxy-secret')
        .update('0123456789abcdef01234567')
        .digest('hex')
    )
  })
})
