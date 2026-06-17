// Load environment variables from .env file (must be first)
import 'dotenv/config'

// Metrics must be initialized before importing anything else
import '@overleaf/metrics/initialize.js'

import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { mongoClient, ensureIndexes } from './app/js/mongodb.js'
import { createServer } from './app/js/server.js'
import AgentController from './app/js/AgentController.js'
import {
  initializeRuntimeConfig,
  shutdownRuntimeConfig,
} from './app/js/RuntimeConfigManager.js'

const port = settings.internal.aiWritingAgent.port
const host = settings.internal.aiWritingAgent.host
let httpServer = null
let shuttingDown = false
const SHUTDOWN_TIMEOUT_MS = settings.shutdown?.timeoutMs || 10_000

async function gracefulShutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'Graceful shutdown requested')

  const forceTimer = setTimeout(() => {
    logger.error({ signal, timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forceTimer.unref()

  try {
    await AgentController.shutdown({ reason: signal })
  } catch (err) {
    logger.error({ err, signal }, 'AgentController shutdown failed')
  }

  try {
    await shutdownRuntimeConfig()
  } catch (err) {
    logger.error({ err }, 'Runtime config shutdown failed')
  }

  if (httpServer) {
    await new Promise(resolve => {
      httpServer.close((err) => {
        if (err) logger.error({ err }, 'HTTP server close failed')
        resolve()
      })
    })
  }

  try {
    await mongoClient.close()
  } catch (err) {
    logger.error({ err }, 'Mongo client close failed')
  }

  clearTimeout(forceTimer)
  process.exit(0)
}

// Global error handlers — catch unhandled rejections and uncaught exceptions
// to prevent silent crashes and ensure errors are logged.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled Promise rejection')
})

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception, shutting down')
  process.exit(1)
})

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.once('SIGINT', () => gracefulShutdown('SIGINT'))

// Block default credentials in production, warn in development
if (settings.apis.web.user === 'overleaf' && settings.apis.web.pass === 'overleaf') {
  const msg =
    'WEB_API_USER and WEB_API_PASSWORD are using default credentials (overleaf/overleaf). ' +
    'This is insecure for production. Set WEB_API_USER and WEB_API_PASSWORD environment variables.'
  if (process.env.NODE_ENV === 'production') {
    logger.fatal(msg)
    process.exit(1)
  } else {
    logger.warn(msg)
  }
}

// Check AI_PROXY_SECRET at startup
{
  const proxySecret = settings.internal?.proxySecret
  const listenHost = settings.internal?.aiWritingAgent?.host || '127.0.0.1'
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(listenHost)
  if (!proxySecret) {
    const msg =
      'AI_PROXY_SECRET is empty. The proxy authentication layer is disabled. ' +
      'Set AI_PROXY_SECRET environment variable to secure the agent endpoint.'
    if (process.env.NODE_ENV === 'production' || !isLoopback) {
      logger.fatal(msg)
      process.exit(1)
    } else {
      logger.warn(msg)
    }
  }
}

mongoClient
  .connect()
  .then(async () => {
    await ensureIndexes()
    await initializeRuntimeConfig()
    await AgentController.initialize()
    const { server } = await createServer()
    httpServer = server
    server.listen(port, host, function (err) {
      if (err) {
        logger.fatal({ err }, `Cannot bind to ${host}:${port}. Exiting.`)
        process.exit(1)
      }
      logger.debug(`AI Writing Agent starting up, listening on ${host}:${port}`)
    })
  })
  .catch(err => {
    logger.fatal({ err }, 'Cannot connect to mongo. Exiting.')
    process.exit(1)
  })
