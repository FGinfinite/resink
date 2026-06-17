import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { ObjectId, db } from './mongodb.js'
import { LLMAdapter } from './adapter/LLMAdapter.js'

function getCacheTtl() {
  return settings.modelConfig?.cacheTtlMs || 60_000
}

function getCacheMax() {
  return settings.modelConfig?.cacheMax || 100
}

/**
 * Evict the oldest entry from a Map when it exceeds max capacity (FIFO).
 */
function _evictIfNeeded(map, max) {
  if (map.size >= max) {
    const firstKey = map.keys().next().value
    map.delete(firstKey)
  }
}

/**
 * Get a cache entry if it exists and has not expired.
 */
function _getCached(map, key) {
  const entry = map.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > getCacheTtl()) {
    map.delete(key)
    return null
  }
  return entry.value
}

/**
 * Set a cache entry with the current timestamp.
 */
function _setCache(map, key, value) {
  _evictIfNeeded(map, getCacheMax())
  map.set(key, { value, ts: Date.now() })
}

class ModelConfigService {
  constructor() {
    /** @type {Map<string, {value: any, ts: number}>} */
    this._slotCache = new Map()
    /** @type {Map<string, {value: any, ts: number}>} */
    this._configCache = new Map()
    /** @type {{value: any, ts: number}|null} */
    this._systemConfigCache = null
    /** @type {Map<string, {adapter: LLMAdapter, ts: number}>} */
    this._adapterCache = new Map()
  }

  // ---------------------------------------------------------------------------
  // Read (with cache)
  // ---------------------------------------------------------------------------

  async getSystemConfig() {
    if (this._systemConfigCache && Date.now() - this._systemConfigCache.ts < getCacheTtl()) {
      return this._systemConfigCache.value
    }
    const doc = await db.aiSystemConfig.findOne({ key: 'modelConfig' })
    this._systemConfigCache = { value: doc, ts: Date.now() }
    return doc
  }

  async getSlot(slug) {
    const cached = _getCached(this._slotCache, slug)
    if (cached) return cached
    const doc = await db.aiModelSlots.findOne({ slug })
    if (doc) _setCache(this._slotCache, slug, doc)
    return doc
  }

  async getAllEnabledSlots() {
    return db.aiModelSlots
      .find({ enabled: true })
      .sort({ sortOrder: 1 })
      .toArray()
  }

  async getAllSlots() {
    return db.aiModelSlots.find({}).sort({ sortOrder: 1 }).toArray()
  }

  async getModelConfig(id) {
    const idStr = id.toString()
    const cached = _getCached(this._configCache, idStr)
    if (cached) return cached
    const doc = await db.aiModelConfigs.findOne({ _id: new ObjectId(idStr) })
    if (doc) _setCache(this._configCache, idStr, doc)
    return doc
  }

  async getAllModelConfigs() {
    return db.aiModelConfigs.find({}).toArray()
  }

  // ---------------------------------------------------------------------------
  // Core: resolve slot → adapter
  // ---------------------------------------------------------------------------

  /**
   * Resolve a slot slug to { adapter, config, slot }.
   * Cached LLMAdapter instances avoid repeated construction.
   */
  async resolveSlot(slotSlug) {
    const slot = await this.getSlot(slotSlug)
    if (!slot) throw new Error(`Model slot not found: ${slotSlug}`)
    if (!slot.enabled) throw new Error(`Model slot is disabled: ${slotSlug}`)

    const config = await this.getModelConfig(slot.modelConfigId)
    if (!config) throw new Error(`Model config not found for slot: ${slotSlug}`)
    if (!config.enabled) throw new Error(`Model config is disabled for slot: ${slotSlug}`)

    const configIdStr = config._id.toString()
    const cachedAdapter = _getCached(this._adapterCache, configIdStr)
    if (cachedAdapter) {
      return { adapter: cachedAdapter, config, slot }
    }

    const adapter = new LLMAdapter({
      apiBase: config.apiBase,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeout: config.timeout,
      retryAttempts: config.retryAttempts,
      retryDelay: config.retryDelay,
      maxRetryTimeMs: config.maxRetryTimeMs,
      proxy: config.proxy,
      supportsImage: config.supportsImage,
      extraBody: config.extraBody,
      maxCompletionTokens: config.maxCompletionTokens,
      maxToolCallTemperature: config.maxToolCallTemperature,
    })

    _setCache(this._adapterCache, configIdStr, adapter)
    return { adapter, config, slot }
  }

  /**
   * Resolve a feature binding (e.g. 'quickEdit', 'autocomplete', 'digestModel')
   * to { adapter, config, slot }.
   */
  async resolveFeatureSlot(feature) {
    const sysConfig = await this.getSystemConfig()
    if (!sysConfig || !sysConfig.featureBindings || !sysConfig.featureBindings[feature]) {
      throw new Error(`No feature binding for: ${feature}`)
    }
    return this.resolveSlot(sysConfig.featureBindings[feature])
  }

  // ---------------------------------------------------------------------------
  // Public slots (safe view, no apiKey)
  // ---------------------------------------------------------------------------

  async getPublicSlots() {
    const slots = await this.getAllEnabledSlots()
    return slots.map(s => ({
      slug: s.slug,
      label: s.label,
      description: s.description || '',
      icon: s.icon || '',
      supportsImage: false, // will be resolved from config
    }))
      // Enrich with supportsImage from config; drop slots with invalid/disabled config
      .map(async s => {
        try {
          const slot = await this.getSlot(s.slug)
          if (slot?.modelConfigId) {
            const config = await this.getModelConfig(slot.modelConfigId)
            if (!config || config.enabled === false) return null
            s.supportsImage = !!config.supportsImage
            return s
          }
        } catch { /* ignore */ }
        return null
      })
      // Wait for all enrichments
      .reduce(async (accP, itemP) => {
        const acc = await accP
        const item = await itemP
        if (item) acc.push(item)
        return acc
      }, Promise.resolve([]))
  }

  // ---------------------------------------------------------------------------
  // Admin CRUD — Model Configs
  // ---------------------------------------------------------------------------

  async createModelConfig(data) {
    const doc = {
      ...data,
      enabled: data.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const result = await db.aiModelConfigs.insertOne(doc)
    this.invalidateAll()
    return { ...doc, _id: result.insertedId }
  }

  async updateModelConfig(id, data) {
    const $set = { updatedAt: new Date() }
    const $unset = {}
    for (const [k, v] of Object.entries(data)) {
      if (k === '_id') continue
      if (v === undefined || v === null) {
        $unset[k] = ''
      } else {
        $set[k] = v
      }
    }
    const update = { $set }
    if (Object.keys($unset).length > 0) update.$unset = $unset
    await db.aiModelConfigs.updateOne(
      { _id: new ObjectId(id) },
      update
    )
    this.invalidateAll()
  }

  async deleteModelConfig(id) {
    // Check no slot references this config
    const refSlot = await db.aiModelSlots.findOne({ modelConfigId: new ObjectId(id) })
    if (refSlot) {
      throw new Error(`Cannot delete config: referenced by slot "${refSlot.slug}"`)
    }
    await db.aiModelConfigs.deleteOne({ _id: new ObjectId(id) })
    this.invalidateAll()
  }

  // ---------------------------------------------------------------------------
  // Admin CRUD — Model Slots
  // ---------------------------------------------------------------------------

  async createSlot(data) {
    const doc = {
      ...data,
      modelConfigId: new ObjectId(data.modelConfigId),
      enabled: data.enabled !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    await db.aiModelSlots.insertOne(doc)
    this.invalidateAll()
    return doc
  }

  async updateSlot(slug, data) {
    const update = { ...data, updatedAt: new Date() }
    delete update._id
    if (update.modelConfigId) {
      update.modelConfigId = new ObjectId(update.modelConfigId)
    }
    await db.aiModelSlots.updateOne(
      { slug },
      { $set: update }
    )
    this.invalidateAll()
  }

  async deleteSlot(slug) {
    // Check not referenced by featureBindings
    const sysConfig = await this.getSystemConfig()
    if (sysConfig?.featureBindings) {
      for (const [feature, boundSlug] of Object.entries(sysConfig.featureBindings)) {
        if (boundSlug === slug) {
          throw new Error(`Cannot delete slot: bound to feature "${feature}"`)
        }
      }
    }
    if (sysConfig?.defaultSlot === slug) {
      throw new Error('Cannot delete slot: it is the default slot')
    }
    await db.aiModelSlots.deleteOne({ slug })
    this.invalidateAll()
  }

  // ---------------------------------------------------------------------------
  // Admin — System Config
  // ---------------------------------------------------------------------------

  async updateSystemConfig(data) {
    const update = { ...data, updatedAt: new Date() }
    delete update._id
    delete update.key
    await db.aiSystemConfig.updateOne(
      { key: 'modelConfig' },
      { $set: update },
      { upsert: true }
    )
    this.invalidateAll()
  }

  // ---------------------------------------------------------------------------
  // Cache management
  // ---------------------------------------------------------------------------

  invalidateAll() {
    this._slotCache.clear()
    this._configCache.clear()
    this._systemConfigCache = null
    this._adapterCache.clear()
    logger.debug({}, 'ModelConfigService: all caches invalidated')
  }
}

// Singleton
let instance = null

export function getModelConfigService() {
  if (!instance) instance = new ModelConfigService()
  return instance
}

export default ModelConfigService
