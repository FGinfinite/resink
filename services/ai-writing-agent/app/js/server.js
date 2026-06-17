import http from 'node:http'
import metrics from '@overleaf/metrics'
import logger from '@overleaf/logger'
import express from 'express'
import bodyParser from 'body-parser'
import { createRouter } from './Router.js'

logger.initialize('ai-writing-agent')
metrics.open_sockets.monitor()
metrics.leaked_sockets.monitor(logger)

export async function createServer() {
  const app = express()

  // Metrics middleware
  app.use(metrics.http.monitor(logger))
  metrics.injectMetricsRoute(app)

  // Body parsing
  app.use(bodyParser.json({ limit: '2mb' }))

  // Health check
  app.get('/status', (req, res) => {
    res.json({ status: 'ok' })
  })

  // API routes
  const router = createRouter()
  app.use('/api/ai', router)

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ message: 'Not found' })
  })

  // Error handler
  app.use((err, req, res, _next) => {
    logger.error({ err, url: req.url }, 'unhandled error')
    const status = err.status || 500
    const message = status < 500 ? err.message : 'Internal error'
    res.status(status).json({
      message,
      code: err.code,
    })
  })

  const server = http.createServer(app)
  return { app, server }
}
