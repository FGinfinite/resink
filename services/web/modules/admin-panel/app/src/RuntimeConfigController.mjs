import Path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import {
  getRuntimeConfigManager,
  listRuntimeConfigServices,
} from '../../../../app/src/infrastructure/RuntimeConfigManager.mjs'

const __dirname = Path.dirname(fileURLToPath(import.meta.url))

function assertKnownService(res, service) {
  if (!listRuntimeConfigServices().includes(service)) {
    res.status(404).json({ error: 'unknown config service' })
    return null
  }
  return getRuntimeConfigManager(service)
}

function configPage(req, res) {
  const title =
    req.i18n.language === 'zh-CN' ? '运行时配置' : 'Runtime Config'
  res.render(Path.resolve(__dirname, '../views/admin/config'), {
    title,
  })
}

async function listServices(req, res) {
  res.json({ services: listRuntimeConfigServices() })
}

async function listEntries(req, res) {
  const manager = assertKnownService(res, req.params.service)
  if (!manager) return
  const entries = await manager.listResolvedEntries()
  res.json({ entries })
}

async function getEntryRevisions(req, res) {
  const manager = assertKnownService(res, req.params.service)
  if (!manager) return
  const revisions = await manager.getRevisions(req.params.key)
  res.json({ revisions })
}

async function updateEntry(req, res) {
  const manager = assertKnownService(res, req.params.service)
  if (!manager) return
  const updatedBy = SessionManager.getLoggedInUserId(req.session)?.toString() || 'unknown'
  const { value, comment } = req.body || {}
  const record = await manager.setRuntimeValue({
    key: req.params.key,
    value,
    comment: typeof comment === 'string' ? comment : '',
    updatedBy,
  })
  res.json({ entry: record })
}

async function resetEntry(req, res) {
  const manager = assertKnownService(res, req.params.service)
  if (!manager) return
  const updatedBy = SessionManager.getLoggedInUserId(req.session)?.toString() || 'unknown'
  const { comment } = req.body || {}
  await manager.resetRuntimeValue({
    key: req.params.key,
    comment: typeof comment === 'string' ? comment : '',
    updatedBy,
  })
  res.sendStatus(204)
}

async function rollbackEntry(req, res) {
  const manager = assertKnownService(res, req.params.service)
  if (!manager) return
  const updatedBy = SessionManager.getLoggedInUserId(req.session)?.toString() || 'unknown'
  const { version, comment } = req.body || {}
  if (!Number.isFinite(Number(version))) {
    return res.status(400).json({ error: 'version is required' })
  }
  const record = await manager.rollbackRuntimeValue({
    key: req.params.key,
    version: Number(version),
    comment: typeof comment === 'string' ? comment : '',
    updatedBy,
  })
  res.json({ entry: record })
}

export default {
  configPage,
  listServices: expressify(listServices),
  listEntries: expressify(listEntries),
  getEntryRevisions: expressify(getEntryRevisions),
  updateEntry: expressify(updateEntry),
  resetEntry: expressify(resetEntry),
  rollbackEntry: expressify(rollbackEntry),
}
