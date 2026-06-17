import settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import ConfigSystem from '@overleaf/config-system'
import { MongoClient } from 'mongodb'

const { ConfigManager, definitionsByService } = ConfigSystem

const mongoClient = new MongoClient(settings.mongo.url)
const mongoDb = mongoClient.db()

const collections = {
  values: mongoDb.collection('appConfigValues'),
  revisions: mongoDb.collection('appConfigRevisions'),
  auditLogs: mongoDb.collection('appConfigAuditLogs'),
}

const manager = new ConfigManager({
  service: 'clsi',
  collections,
  definitions: definitionsByService.clsi || [],
  redisConfig: settings.redis?.pubsub,
  logger,
  cacheTtlMs: settings.runtimeConfig?.cacheTtlMs,
})

let initializedPromise = null
let fallbackRefreshTimer = null

async function refreshRuntimeSettings() {
  manager.invalidateCache()
  await manager.applyResolvedSettings(settings)
}

function stopFallbackRefreshLoop() {
  if (fallbackRefreshTimer) {
    clearInterval(fallbackRefreshTimer)
    fallbackRefreshTimer = null
  }
}

function startFallbackRefreshLoop() {
  stopFallbackRefreshLoop()
  const intervalMs =
    settings.runtimeConfig?.fallbackRefreshIntervalMs ??
    settings.runtimeConfig?.cacheTtlMs ??
    30000

  fallbackRefreshTimer = setInterval(() => {
    refreshRuntimeSettings().catch(err => {
      logger.warn(
        { err },
        'failed to refresh clsi runtime config from fallback loop'
      )
    })
  }, intervalMs)
  fallbackRefreshTimer.unref?.()
}

export async function initializeRuntimeConfig() {
  if (!initializedPromise) {
    initializedPromise = (async () => {
      await mongoClient.connect()
      await manager.ensureIndexes()
      await refreshRuntimeSettings()
      manager.on('updated', () => {
        refreshRuntimeSettings().catch(err => {
          logger.warn({ err }, 'failed to refresh clsi runtime config')
        })
      })
      if (manager.redisConfig) {
        try {
          await manager.start()
          stopFallbackRefreshLoop()
        } catch (err) {
          logger.warn(
            { err },
            'runtime config pubsub unavailable for clsi, enabling fallback refresh loop'
          )
          startFallbackRefreshLoop()
        }
      } else {
        logger.warn(
          'runtime config pubsub is not configured for clsi, enabling fallback refresh loop'
        )
        startFallbackRefreshLoop()
      }
      return manager
    })()
  }

  return initializedPromise
}

export async function shutdownRuntimeConfig() {
  stopFallbackRefreshLoop()
  await manager.stop()
  await mongoClient.close()
}
