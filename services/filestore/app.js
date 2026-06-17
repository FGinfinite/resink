// Metrics must be initialized before importing anything else
import '@overleaf/metrics/initialize.js'

import Events from 'node:events'
import Metrics from '@overleaf/metrics'
import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import express from 'express'
import { fileURLToPath } from 'node:url'
import fileController from './app/js/FileController.js'
import keyBuilder from './app/js/KeyBuilder.js'
import RequestLogger from './app/js/RequestLogger.js'

logger.initialize(process.env.METRICS_APP_NAME || 'filestore')

Events.setMaxListeners(20)

const app = express()

app.use(RequestLogger.middleware)

Metrics.open_sockets.monitor(true)
Metrics.memory.monitor(logger)
if (Metrics.event_loop) {
  Metrics.event_loop.monitor(logger)
}
Metrics.leaked_sockets.monitor(logger)

app.use(function (req, res, next) {
  Metrics.inc('http-request')
  next()
})

// Handle requests that come in after we've started shutting down
app.use((req, res, next) => {
  if (settings.shuttingDown) {
    logger.warn(
      { req, timeSinceShutdown: Date.now() - settings.shutDownTime },
      'request received after shutting down'
    )
    // We don't want keep-alive connections to be kept open when the server is shutting down.
    res.set('Connection', 'close')
  }
  next()
})

Metrics.injectMetricsRoute(app)

if (settings.filestore.stores.template_files) {
  app.head(
    '/template/:template_id/v/:version/:format',
    keyBuilder.templateFileKeyMiddleware,
    fileController.getFileHead
  )
  app.get(
    '/template/:template_id/v/:version/:format',
    keyBuilder.templateFileKeyMiddleware,
    fileController.getFile
  )
  app.get(
    '/template/:template_id/v/:version/:format/:sub_type',
    keyBuilder.templateFileKeyMiddleware,
    fileController.getFile
  )
  app.post(
    '/template/:template_id/v/:version/:format',
    keyBuilder.templateFileKeyMiddleware,
    fileController.insertFile
  )
}

app.get(
  '/bucket/:bucket/key/*',
  optionalReadSecret,
  keyBuilder.bucketFileKeyMiddleware,
  fileController.getFile
)

// Restrict POST/DELETE bucket operations to allowed buckets only
const WRITABLE_BUCKETS = new Set(['ai_attachments'])
function restrictBucketWrite(req, res, next) {
  if (!WRITABLE_BUCKETS.has(req.params.bucket)) {
    return res.status(403).send('Write access not permitted for this bucket')
  }
  next()
}

// Require a shared secret for write operations on bucket routes
function requireWriteSecret(req, res, next) {
  const expectedSecret = settings.internal?.filestore?.writeSecret
  if (!expectedSecret) {
    // Default deny — require explicit configuration
    logger.warn({}, 'filestore write secret not configured, rejecting write request')
    return res.status(500).send('filestore write secret not configured')
  }
  const provided = req.headers['x-filestore-write-secret']
  if (provided !== expectedSecret) {
    return res.status(401).send('invalid write secret')
  }
  next()
}

// Optional read secret for bucket GET routes (backward-compatible)
function optionalReadSecret(req, res, next) {
  const expectedSecret = settings.internal?.filestore?.readSecret
  if (!expectedSecret) {
    // ai_attachments requires explicit read secret configuration
    if (req.params.bucket === 'ai_attachments') {
      logger.warn({}, 'filestore read secret not configured, rejecting ai_attachments read')
      return res.status(500).send('filestore read secret not configured for ai_attachments')
    }
    return next() // backward-compatible: no secret configured = allow reads for other buckets
  }
  const provided = req.headers['x-filestore-read-secret']
  if (provided !== expectedSecret) {
    return res.status(401).send('invalid read secret')
  }
  next()
}

app.post(
  '/bucket/:bucket/key/*',
  requireWriteSecret,
  restrictBucketWrite,
  keyBuilder.bucketFileKeyMiddleware,
  fileController.insertFile
)

app.delete(
  '/bucket/:bucket/key/*',
  requireWriteSecret,
  restrictBucketWrite,
  keyBuilder.bucketFileKeyMiddleware,
  fileController.deleteFile
)

app.get(
  '/history/global/hash/:hash',
  keyBuilder.globalBlobFileKeyMiddleware,
  fileController.getFile
)
app.get(
  '/history/project/:historyId/hash/:hash',
  keyBuilder.projectBlobFileKeyMiddleware,
  fileController.getFile
)

app.get('/status', function (req, res) {
  if (settings.shuttingDown) {
    res.sendStatus(503) // Service unavailable
  } else {
    res.send('filestore is up')
  }
})

app.get('/health_check', (req, res) => {
  res.sendStatus(200)
})

app.use(RequestLogger.errorHandler)

const port = settings.internal.filestore.port || 3009
const host = settings.internal.filestore.host || '0.0.0.0'

let server = null
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Called directly
  server = app.listen(port, host, error => {
    if (error) {
      logger.error({ err: error }, 'Error starting Filestore')
      throw error
    }
    logger.debug(`Filestore starting up, listening on ${host}:${port}`)
  })
}

process
  .on('unhandledRejection', (reason, p) => {
    logger.err(reason, 'Unhandled Rejection at Promise', p)
  })
  .on('uncaughtException', err => {
    logger.err(err, 'Uncaught Exception thrown')
    process.exit(1)
  })

function handleShutdownSignal(signal) {
  logger.info({ signal }, 'received interrupt, cleaning up')
  if (settings.shuttingDown) {
    logger.warn({ signal }, 'already shutting down, ignoring interrupt')
    return
  }
  settings.shuttingDown = true
  settings.shutDownTime = Date.now()
  // stop accepting new connections, the callback is called when existing connections have finished
  server.close(() => {
    logger.info({ signal }, 'server closed')
    // exit after a short delay so logs can be flushed
    setTimeout(() => {
      process.exit()
    }, 100)
  })
  // close idle http keep-alive connections
  server.closeIdleConnections()
  setTimeout(() => {
    logger.info({ signal }, 'shutdown timed out, exiting')
    // close all connections immediately
    server.closeAllConnections()
    // exit after a short delay to allow for cleanup
    setTimeout(() => {
      process.exit()
    }, 100)
  }, settings.gracefulShutdownDelayInMs)
}

process.on('SIGTERM', handleShutdownSignal)

export default app
