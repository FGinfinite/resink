import settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import ConfigSystem from '@overleaf/config-system'
import { db } from './mongodb.mjs'
import { addConnectionDrainer } from './GracefulShutdown.mjs'

const { ConfigManager, definitionsByService } = ConfigSystem

const collections = {
  values: db.appConfigValues,
  revisions: db.appConfigRevisions,
  auditLogs: db.appConfigAuditLogs,
}

const managers = new Map()
let initializedPromise = null
let fallbackRefreshTimer = null

function createManager(service) {
  return new ConfigManager({
    service,
    collections,
    definitions: definitionsByService[service] || [],
    redisConfig: settings.redis.pubsub || settings.redis.web,
    logger,
    cacheTtlMs: settings.runtimeConfig?.cacheTtlMs,
  })
}

async function refreshRuntimeSettings(manager) {
  manager.invalidateCache()
  await manager.applyResolvedSettings(settings)
}

function stopFallbackRefreshLoop() {
  if (fallbackRefreshTimer) {
    clearInterval(fallbackRefreshTimer)
    fallbackRefreshTimer = null
  }
}

function startFallbackRefreshLoop(manager) {
  stopFallbackRefreshLoop()
  const intervalMs =
    settings.runtimeConfig?.fallbackRefreshIntervalMs ??
    settings.runtimeConfig?.cacheTtlMs ??
    30000

  fallbackRefreshTimer = setInterval(() => {
    refreshRuntimeSettings(manager).catch(err => {
      logger.warn({ err }, 'failed to refresh web runtime config from fallback loop')
    })
  }, intervalMs)
  fallbackRefreshTimer.unref?.()
}

export function getRuntimeConfigManager(service = 'web') {
  if (!managers.has(service)) {
    managers.set(service, createManager(service))
  }
  return managers.get(service)
}

export function listRuntimeConfigServices() {
  return Object.keys(definitionsByService)
}

export async function initializeRuntimeConfig() {
  if (!initializedPromise) {
    initializedPromise = (async () => {
      const manager = getRuntimeConfigManager('web')
      await manager.ensureIndexes()
      await refreshRuntimeSettings(manager)
      manager.on('updated', () => {
        refreshRuntimeSettings(manager).catch(err => {
          logger.warn({ err }, 'failed to refresh web runtime config')
        })
      })
      if (manager.redisConfig) {
        try {
          await manager.start()
          stopFallbackRefreshLoop()
        } catch (err) {
          logger.warn(
            { err },
            'runtime config pubsub unavailable for web, enabling fallback refresh loop'
          )
          startFallbackRefreshLoop(manager)
        }
      } else {
        logger.warn(
          'runtime config pubsub is not configured for web, enabling fallback refresh loop'
        )
        startFallbackRefreshLoop(manager)
      }
      addConnectionDrainer('runtime config web', async () => {
        stopFallbackRefreshLoop()
        await manager.stop()
      })
      return manager
    })()
  }

  return initializedPromise
}
