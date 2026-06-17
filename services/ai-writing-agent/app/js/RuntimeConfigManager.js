import settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import ConfigSystem from '@overleaf/config-system'
import { db } from './mongodb.js'

const { ConfigManager, definitionsByService } = ConfigSystem

const collections = {
  values: db.appConfigValues,
  revisions: db.appConfigRevisions,
  auditLogs: db.appConfigAuditLogs,
}

const manager = new ConfigManager({
  service: 'ai-writing-agent',
  collections,
  definitions: definitionsByService['ai-writing-agent'] || [],
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
        'failed to refresh ai runtime config from fallback loop'
      )
    })
  }, intervalMs)
  fallbackRefreshTimer.unref?.()
}

export async function initializeRuntimeConfig() {
  if (!initializedPromise) {
    initializedPromise = (async () => {
      await manager.ensureIndexes()
      await refreshRuntimeSettings()
      manager.on('updated', () => {
        refreshRuntimeSettings().catch(err => {
          logger.warn({ err }, 'failed to refresh ai runtime config')
        })
      })
      if (manager.redisConfig) {
        try {
          await manager.start()
          stopFallbackRefreshLoop()
        } catch (err) {
          logger.warn(
            { err },
            'runtime config pubsub unavailable for ai-writing-agent, enabling fallback refresh loop'
          )
          startFallbackRefreshLoop()
        }
      } else {
        logger.warn(
          'runtime config pubsub is not configured for ai-writing-agent, enabling fallback refresh loop'
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
}

export function getRuntimeConfigManager() {
  return manager
}
