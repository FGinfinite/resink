import { expressify } from '@overleaf/promise-utils'
import logger from '@overleaf/logger'
import { getModelConfigService } from './ModelConfigService.js'
import { ObjectId } from './mongodb.js'

function maskApiKey(key) {
  if (!key || key.length < 12) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

// ---------------------------------------------------------------------------
// User endpoints (read-only)
// ---------------------------------------------------------------------------

async function listSlots(req, res) {
  const svc = getModelConfigService()
  const slots = await svc.getPublicSlots()
  res.json({ slots })
}

async function getDefaultSlot(req, res) {
  const svc = getModelConfigService()
  const systemConfig = await svc.getSystemConfig()
  res.json({ defaultSlot: systemConfig?.defaultSlot || null })
}

// ---------------------------------------------------------------------------
// Admin — Model Configs
// ---------------------------------------------------------------------------

async function listConfigs(req, res) {
  const svc = getModelConfigService()
  const configs = await svc.getAllModelConfigs()
  const masked = configs.map(c => ({
    ...c,
    apiKey: maskApiKey(c.apiKey),
  }))
  res.json({ configs: masked })
}

async function createConfig(req, res) {
  const { apiBase, apiKey, model, displayName } = req.body
  if (!apiBase || !apiKey || !model || !displayName) {
    return res.status(400).json({ error: 'Missing required fields: apiBase, apiKey, model, displayName' })
  }
  const svc = getModelConfigService()
  const config = await svc.createModelConfig(req.body)
  logger.info({ configId: config._id }, 'Admin created model config')
  res.status(201).json({ config: { ...config, apiKey: maskApiKey(config.apiKey) } })
}

async function updateConfig(req, res) {
  const { id } = req.params
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid model config id' })
  }
  const svc = getModelConfigService()
  const existing = await svc.getModelConfig(id)
  if (!existing) {
    return res.status(404).json({ error: 'Model config not found' })
  }
  await svc.updateModelConfig(id, req.body)
  logger.info({ configId: id }, 'Admin updated model config')
  res.json({ success: true })
}

async function deleteConfig(req, res) {
  const { id } = req.params
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid model config id' })
  }
  const svc = getModelConfigService()
  const existing = await svc.getModelConfig(id)
  if (!existing) {
    return res.status(404).json({ error: 'Model config not found' })
  }
  try {
    await svc.deleteModelConfig(id)
  } catch (err) {
    return res.status(409).json({ error: err.message })
  }
  logger.info({ configId: id }, 'Admin deleted model config')
  res.json({ success: true })
}

// ---------------------------------------------------------------------------
// Admin — Model Slots
// ---------------------------------------------------------------------------

async function listAdminSlots(req, res) {
  const svc = getModelConfigService()
  const slots = await svc.getAllSlots()
  res.json({ slots })
}

async function createSlot(req, res) {
  const { slug, label, modelConfigId } = req.body
  if (!slug || !label || !modelConfigId) {
    return res.status(400).json({ error: 'Missing required fields: slug, label, modelConfigId' })
  }
  const svc = getModelConfigService()
  const slot = await svc.createSlot(req.body)
  logger.info({ slug }, 'Admin created model slot')
  res.status(201).json({ slot })
}

async function updateSlot(req, res) {
  const { slug } = req.params
  const svc = getModelConfigService()
  const existing = await svc.getSlot(slug)
  if (!existing) {
    return res.status(404).json({ error: 'Model slot not found' })
  }
  await svc.updateSlot(slug, req.body)
  logger.info({ slug }, 'Admin updated model slot')
  res.json({ success: true })
}

async function deleteSlot(req, res) {
  const { slug } = req.params
  const svc = getModelConfigService()
  const existing = await svc.getSlot(slug)
  if (!existing) {
    return res.status(404).json({ error: 'Model slot not found' })
  }
  try {
    await svc.deleteSlot(slug)
  } catch (err) {
    return res.status(409).json({ error: err.message })
  }
  logger.info({ slug }, 'Admin deleted model slot')
  res.json({ success: true })
}

// ---------------------------------------------------------------------------
// Admin — System Config
// ---------------------------------------------------------------------------

async function getSystemConfig(req, res) {
  const svc = getModelConfigService()
  const config = await svc.getSystemConfig()
  res.json({ config: config || {} })
}

async function updateSystemConfig(req, res) {
  const svc = getModelConfigService()
  await svc.updateSystemConfig(req.body)
  logger.info({}, 'Admin updated system config')
  res.json({ success: true })
}

export default {
  listSlots: expressify(listSlots),
  getDefaultSlot: expressify(getDefaultSlot),
  listConfigs: expressify(listConfigs),
  createConfig: expressify(createConfig),
  updateConfig: expressify(updateConfig),
  deleteConfig: expressify(deleteConfig),
  listAdminSlots: expressify(listAdminSlots),
  createSlot: expressify(createSlot),
  updateSlot: expressify(updateSlot),
  deleteSlot: expressify(deleteSlot),
  getSystemConfig: expressify(getSystemConfig),
  updateSystemConfig: expressify(updateSystemConfig),
}
