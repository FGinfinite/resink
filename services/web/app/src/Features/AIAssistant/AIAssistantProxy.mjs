import crypto from 'node:crypto'
import Settings from '@overleaf/settings'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware'
import Errors from '../Errors/Errors.js'
import SessionManager from '../Authentication/SessionManager.mjs'

const AIAssistantProxy = {
  createProxy() {
    const aiAssistantUrl = Settings.aiAssistantUrl
    if (!aiAssistantUrl) {
      return (req, res, next) =>
        next(
          new Errors.ServiceNotConfiguredError(
            'AI Assistant service not configured'
          )
        )
    }

    // Extract base URL (remove /api/ai suffix if present)
    const baseUrl = aiAssistantUrl.replace(/\/api\/ai\/?$/, '')

    // Validate protocol and hostname whitelist
    let parsedUrl
    try {
      parsedUrl = new URL(baseUrl)
    } catch {
      return (req, res, next) =>
        next(
          new Errors.ServiceNotConfiguredError(
            'AI Assistant URL is invalid: ' + baseUrl
          )
        )
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return (req, res, next) =>
        next(
          new Errors.ServiceNotConfiguredError(
            'AI Assistant URL must use http or https protocol, got: ' +
              parsedUrl.protocol
          )
        )
    }

    // Whitelist check: enforce in production, skip in development
    const allowedHosts = Settings.aiAssistant?.allowedHosts
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        return (req, res, next) =>
          next(
            new Errors.ServiceNotConfiguredError(
              'AI Assistant allowedHosts must be configured in production'
            )
          )
      }
    } else if (!allowedHosts.includes(parsedUrl.hostname)) {
      return (req, res, next) =>
        next(
          new Errors.ServiceNotConfiguredError(
            'AI Assistant hostname not in allowedHosts whitelist: ' +
              parsedUrl.hostname
          )
        )
    }

    // Timeout configuration: differentiate SSE (long-lived) vs normal requests
    const sseTimeoutMs = Settings.aiAssistant?.sseTimeoutMs || 300000 // 5 minutes
    const proxyTimeoutMs = Settings.aiAssistant?.proxyTimeoutMs || 60000 // 1 minute

    return createProxyMiddleware({
      target: baseUrl,
      changeOrigin: true,
      timeout: sseTimeoutMs, // default to SSE timeout as upper bound
      proxyTimeout: sseTimeoutMs,
      pathRewrite(path) {
        const relativePath = path.replace(/^\/api\/ai(?=\/|$)/, '')
        return `/api/ai${relativePath || '/'}`
      },
      // Fix request body after Express body-parser has consumed it
      onProxyReq(proxyReq, req, res) {
        // Set timeout based on whether this is an SSE request
        const isSSE =
          req.headers.accept && req.headers.accept.includes('text/event-stream')
        const timeoutMs = isSSE ? sseTimeoutMs : proxyTimeoutMs
        proxyReq.setTimeout(timeoutMs)
        req.setTimeout(timeoutMs)

        // 移除敏感请求头，只透传必要头
        proxyReq.removeHeader('cookie')
        proxyReq.removeHeader('authorization')
        // 清除用户可能自带的 AI 信任头，防止伪造
        proxyReq.removeHeader('x-user-id')
        proxyReq.removeHeader('x-user-sig')
        proxyReq.removeHeader('x-user-is-admin')
        proxyReq.removeHeader('x-ai-proxy-secret')
        const userId = SessionManager.getLoggedInUserId(req.session)
        if (userId) {
          proxyReq.setHeader('x-user-id', userId)
          const hmacSecret = Settings.aiAssistant?.proxySecret
          if (hmacSecret) {
            const sig = crypto
              .createHmac('sha256', hmacSecret)
              .update(userId)
              .digest('hex')
            proxyReq.setHeader('x-user-sig', sig)
          }
        }
        const proxySecret = Settings.aiAssistant?.proxySecret
        if (proxySecret) {
          proxyReq.setHeader('x-ai-proxy-secret', proxySecret)
        }
        // Inject admin flag for ai-writing-agent admin endpoints
        const sessionUser = req.session?.user || req.session?.passport?.user
        const isAdmin = sessionUser?.isAdmin === true
        if (isAdmin) {
          proxyReq.setHeader('x-user-is-admin', 'true')
        }
        // multipart/form-data body is not consumed by body-parser,
        // must let the raw stream pass through — fixRequestBody would corrupt it
        const contentType = req.headers['content-type'] || ''
        if (!contentType.includes('multipart/form-data')) {
          fixRequestBody(proxyReq, req, res)
        }
      },
      // Required for SSE streaming support
      onProxyRes(proxyRes, req, res) {
        // Disable buffering for SSE responses
        if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
          res.setHeader('X-Accel-Buffering', 'no')
        }
      },
      onError(err, req, res) {
        if (res.headersSent || res.writableEnded) {
          try { res.end() } catch (_) { /* connection may already be closed */ }
          return
        }
        if (err.code === 'ECONNREFUSED') {
          return res.status(503).json({
            error: 'AI Assistant service unavailable',
          })
        }
        res.status(502).json({ error: 'Proxy error' })
      },
    })
  },
}

export default AIAssistantProxy
