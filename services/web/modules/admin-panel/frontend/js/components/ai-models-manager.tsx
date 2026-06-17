import React, { useState, useEffect, useCallback } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import AdminNav from './admin-nav'
import {
  listConfigs,
  createConfig,
  updateConfig,
  deleteConfig,
  listSlots,
  createSlot,
  updateSlot,
  deleteSlot,
  getSystemConfig,
  updateSystemConfig,
} from '../api/ai-admin-api'

type TabKey = 'configs' | 'slots' | 'system'

interface ModelConfig {
  _id: string
  displayName: string
  model: string
  apiBase: string
  apiKey: string
  enabled: boolean
  supportsImage: boolean
  maxTokens?: number
  temperature?: number
  timeout?: number
  retryAttempts?: number
  retryDelay?: number
  maxRetryTimeMs?: number
  proxy?: string
  extraBody?: string | Record<string, unknown>
  maxCompletionTokens?: number
  maxToolCallTemperature?: number
  createdAt?: string
}

interface ModelSlot {
  _id: string
  slug: string
  label: string
  modelConfigId: string
  icon?: string
  sortOrder?: number
  enabled: boolean
}

interface SystemConfig {
  defaultSlot?: string
  featureBindings?: {
    quickEdit?: string
    autocomplete?: string
    digestModel?: string
  }
}

const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1050,
}

const modalContentStyle: React.CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: '6px',
  padding: '24px',
  minWidth: '500px',
  maxWidth: '600px',
  maxHeight: '80vh',
  overflowY: 'auto',
}

function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}

// ── Config Form Modal ──

interface ConfigFormProps {
  config: Partial<ModelConfig> | null
  onSave: (data: Record<string, unknown>) => void
  onClose: () => void
}

function ConfigFormModal({ config, onSave, onClose }: ConfigFormProps) {
  const isEdit = !!config?._id
  const [form, setForm] = useState({
    displayName: config?.displayName || '',
    model: config?.model || '',
    apiBase: config?.apiBase || '',
    apiKey: '',
    enabled: config?.enabled ?? true,
    supportsImage: config?.supportsImage ?? false,
    maxTokens: config?.maxTokens != null ? String(config.maxTokens) : '',
    temperature: config?.temperature != null ? String(config.temperature) : '',
    timeout: config?.timeout != null ? String(config.timeout) : '',
    retryAttempts: config?.retryAttempts != null ? String(config.retryAttempts) : '',
    retryDelay: config?.retryDelay != null ? String(config.retryDelay) : '',
    maxRetryTimeMs: config?.maxRetryTimeMs != null ? String(config.maxRetryTimeMs) : '',
    proxy: config?.proxy || '',
    extraBody: config?.extraBody
      ? (typeof config.extraBody === 'object' ? JSON.stringify(config.extraBody, null, 2) : config.extraBody)
      : '',
    maxCompletionTokens: config?.maxCompletionTokens != null ? String(config.maxCompletionTokens) : '',
    maxToolCallTemperature: config?.maxToolCallTemperature != null ? String(config.maxToolCallTemperature) : '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const numOrNull = (v: string) => v === '' ? null : Number(v)
    const data: Record<string, unknown> = {
      displayName: form.displayName,
      model: form.model,
      apiBase: form.apiBase,
      enabled: form.enabled,
      supportsImage: form.supportsImage,
      maxTokens: numOrNull(form.maxTokens),
      temperature: numOrNull(form.temperature),
      timeout: numOrNull(form.timeout),
      retryAttempts: numOrNull(form.retryAttempts),
      retryDelay: numOrNull(form.retryDelay),
      maxRetryTimeMs: numOrNull(form.maxRetryTimeMs),
      proxy: form.proxy || null,
      maxCompletionTokens: numOrNull(form.maxCompletionTokens),
      maxToolCallTemperature: numOrNull(form.maxToolCallTemperature),
    }
    // Parse extraBody as JSON object if non-empty, otherwise omit
    if (typeof form.extraBody === 'string' && form.extraBody.trim()) {
      try {
        data.extraBody = JSON.parse(form.extraBody)
      } catch {
        alert('extraBody must be valid JSON (e.g. {"disable_reasoning": true})')
        return
      }
    } else {
      data.extraBody = {}
    }
    if (form.apiKey) {
      data.apiKey = form.apiKey
    } else if (!isEdit) {
      // apiKey is required for new configs
      data.apiKey = form.apiKey
    }
    onSave(data)
  }

  const numField = (
    label: string,
    key: 'maxTokens' | 'temperature' | 'timeout' | 'retryAttempts' | 'retryDelay' | 'maxRetryTimeMs' | 'maxCompletionTokens' | 'maxToolCallTemperature',
    opts?: { step?: string; min?: string; helpText?: string; placeholder?: string }
  ) => (
    <div className="form-group" style={{ marginBottom: '12px' }}>
      <label>{label}</label>
      <input
        className="form-control"
        type="number"
        step={opts?.step || '1'}
        min={opts?.min || '0'}
        placeholder={opts?.placeholder}
        value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      />
      {opts?.helpText && (
        <span className="help-block" style={{ fontSize: '12px' }}>
          {opts.helpText}
        </span>
      )}
    </div>
  )

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalContentStyle} onClick={e => e.stopPropagation()}>
        <h4>{isEdit ? 'Edit Model Config' : 'New Model Config'}</h4>
        <form onSubmit={handleSubmit}>
          {/* ── Basic ── */}
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Display Name *</label>
            <input
              className="form-control"
              required
              value={form.displayName}
              onChange={e =>
                setForm(f => ({ ...f, displayName: e.target.value }))
              }
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Model *</label>
            <input
              className="form-control"
              required
              value={form.model}
              onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>API Base *</label>
            <input
              className="form-control"
              required
              value={form.apiBase}
              onChange={e => setForm(f => ({ ...f, apiBase: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>API Key {isEdit ? '(leave blank to keep current)' : '*'}</label>
            <input
              className="form-control"
              type="password"
              required={!isEdit}
              value={form.apiKey}
              onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Proxy</label>
            <input
              className="form-control"
              placeholder="socks5://host:port or http://host:port"
              value={form.proxy}
              onChange={e => setForm(f => ({ ...f, proxy: e.target.value }))}
            />
          </div>

          {/* ── Generation Parameters ── */}
          <h5 style={{ marginTop: '16px', marginBottom: '8px', borderBottom: '1px solid #eee', paddingBottom: '4px' }}>
            Generation Parameters
            <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#888', marginLeft: '8px' }}>
              Leave empty = not sent to API
            </span>
          </h5>
          {numField('Max Tokens', 'maxTokens', { placeholder: '4096', helpText: 'Leave empty: not sent, API uses model default' })}
          {numField('Temperature', 'temperature', { step: '0.1', min: '0', placeholder: '0.7', helpText: 'Leave empty: not sent, API uses model default' })}
          {numField('Max Completion Tokens', 'maxCompletionTokens', { placeholder: '0', helpText: 'For reasoning models (max_completion_tokens). Leave empty: disabled' })}
          {numField('Max Tool-Call Temperature', 'maxToolCallTemperature', { step: '0.1', min: '0', placeholder: '0.5', helpText: 'Clamp temperature when tools are active. Leave empty: no clamping' })}

          {/* ── Reliability ── */}
          <h5 style={{ marginTop: '16px', marginBottom: '8px', borderBottom: '1px solid #eee', paddingBottom: '4px' }}>
            Reliability
            <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#888', marginLeft: '8px' }}>
              Leave empty = use built-in default (shown in placeholder)
            </span>
          </h5>
          {numField('Timeout (ms)', 'timeout', { placeholder: '60000', helpText: 'Leave empty: defaults to 60000ms' })}
          {numField('Retry Attempts', 'retryAttempts', { placeholder: '3', helpText: 'Leave empty: defaults to 3' })}
          {numField('Retry Delay (ms)', 'retryDelay', { placeholder: '1000', helpText: 'Initial delay between retries. Leave empty: defaults to 1000ms' })}
          {numField('Max Retry Time (ms)', 'maxRetryTimeMs', { placeholder: '120000', helpText: 'Total retry time budget. Leave empty: defaults to 120000ms' })}

          {/* ── Advanced ── */}
          <h5 style={{ marginTop: '16px', marginBottom: '8px', borderBottom: '1px solid #eee', paddingBottom: '4px' }}>
            Advanced
          </h5>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Extra Body (JSON)</label>
            <textarea
              className="form-control"
              rows={3}
              placeholder='{"disable_reasoning": true}'
              value={form.extraBody}
              onChange={e => setForm(f => ({ ...f, extraBody: e.target.value }))}
            />
            <span className="help-block" style={{ fontSize: '12px' }}>
              Provider-specific extra parameters merged into request body
            </span>
          </div>

          {/* ── Toggles ── */}
          <div className="checkbox" style={{ marginBottom: '8px' }}>
            <label>
              <input
                type="checkbox"
                checked={form.supportsImage}
                onChange={e =>
                  setForm(f => ({ ...f, supportsImage: e.target.checked }))
                }
              />{' '}
              Supports Image (multimodal vision input)
            </label>
          </div>
          <div className="checkbox" style={{ marginBottom: '16px' }}>
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e =>
                  setForm(f => ({ ...f, enabled: e.target.checked }))
                }
              />{' '}
              Enabled
            </label>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <OLButton variant="secondary" onClick={onClose}>
              Cancel
            </OLButton>
            <OLButton variant="primary" type="submit">
              {isEdit ? 'Update' : 'Create'}
            </OLButton>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Slot Form Modal ──

interface SlotFormProps {
  slot: Partial<ModelSlot> | null
  configs: ModelConfig[]
  onSave: (data: Record<string, unknown>) => void
  onClose: () => void
}

function SlotFormModal({ slot, configs, onSave, onClose }: SlotFormProps) {
  const isEdit = !!slot?._id
  const [form, setForm] = useState({
    slug: slot?.slug || '',
    label: slot?.label || '',
    modelConfigId: slot?.modelConfigId || '',
    icon: slot?.icon || '',
    sortOrder: slot?.sortOrder ?? 0,
    enabled: slot?.enabled ?? true,
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({ ...form, sortOrder: Number(form.sortOrder) })
  }

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalContentStyle} onClick={e => e.stopPropagation()}>
        <h4>{isEdit ? 'Edit Model Slot' : 'New Model Slot'}</h4>
        <form onSubmit={handleSubmit}>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Slug *</label>
            <input
              className="form-control"
              required
              disabled={isEdit}
              value={form.slug}
              onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Label *</label>
            <input
              className="form-control"
              required
              value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Model Config *</label>
            <select
              className="form-control"
              required
              value={form.modelConfigId}
              onChange={e =>
                setForm(f => ({ ...f, modelConfigId: e.target.value }))
              }
            >
              <option value="">-- Select --</option>
              {configs
                .filter(c => c.enabled)
                .map(c => (
                  <option key={c._id} value={c._id}>
                    {c.displayName} ({c.model})
                  </option>
                ))}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Icon</label>
            <input
              className="form-control"
              value={form.icon}
              onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}
            />
          </div>
          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Sort Order</label>
            <input
              className="form-control"
              type="number"
              value={form.sortOrder}
              onChange={e =>
                setForm(f => ({ ...f, sortOrder: Number(e.target.value) }))
              }
            />
          </div>
          <div className="checkbox" style={{ marginBottom: '16px' }}>
            <label>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e =>
                  setForm(f => ({ ...f, enabled: e.target.checked }))
                }
              />{' '}
              Enabled
            </label>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <OLButton variant="secondary" onClick={onClose}>
              Cancel
            </OLButton>
            <OLButton variant="primary" type="submit">
              {isEdit ? 'Update' : 'Create'}
            </OLButton>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Component ──

export default function AIModelsManager() {
  const [activeTab, setActiveTab] = useState<TabKey>('configs')
  const [configs, setConfigs] = useState<ModelConfig[]>([])
  const [slots, setSlots] = useState<ModelSlot[]>([])
  const [systemCfg, setSystemCfg] = useState<SystemConfig>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingConfig, setEditingConfig] = useState<Partial<ModelConfig> | null>(null)
  const [showConfigModal, setShowConfigModal] = useState(false)
  const [editingSlot, setEditingSlot] = useState<Partial<ModelSlot> | null>(null)
  const [showSlotModal, setShowSlotModal] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [cfgRes, slotRes, sysRes] = await Promise.all([
        listConfigs(),
        listSlots(),
        getSystemConfig(),
      ])
      setConfigs((cfgRes as any).configs ?? (cfgRes as any) ?? [])
      setSlots((slotRes as any).slots ?? (slotRes as any) ?? [])
      setSystemCfg((sysRes as any) ?? {})
    } catch (err: any) {
      setError(err.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // ── Config CRUD ──

  const handleSaveConfig = useCallback(
    async (data: Record<string, unknown>) => {
      try {
        if (editingConfig?._id) {
          await updateConfig(editingConfig._id, data)
        } else {
          await createConfig(data)
        }
        setShowConfigModal(false)
        setEditingConfig(null)
        await fetchAll()
      } catch (err: any) {
        setError(err.message || 'Failed to save config')
      }
    },
    [editingConfig, fetchAll]
  )

  const handleDeleteConfig = useCallback(
    async (id: string) => {
      if (!window.confirm('Are you sure you want to delete this model config?'))
        return
      try {
        await deleteConfig(id)
        await fetchAll()
      } catch (err: any) {
        setError(err.message || 'Failed to delete config')
      }
    },
    [fetchAll]
  )

  // ── Slot CRUD ──

  const handleSaveSlot = useCallback(
    async (data: Record<string, unknown>) => {
      try {
        if (editingSlot?._id) {
          await updateSlot(editingSlot.slug!, data)
        } else {
          await createSlot(data)
        }
        setShowSlotModal(false)
        setEditingSlot(null)
        await fetchAll()
      } catch (err: any) {
        setError(err.message || 'Failed to save slot')
      }
    },
    [editingSlot, fetchAll]
  )

  const handleDeleteSlot = useCallback(
    async (slug: string) => {
      if (!window.confirm('Are you sure you want to delete this model slot?'))
        return
      try {
        await deleteSlot(slug)
        await fetchAll()
      } catch (err: any) {
        setError(err.message || 'Failed to delete slot')
      }
    },
    [fetchAll]
  )

  // ── System Config ──

  const handleSaveSystem = useCallback(
    async (data: SystemConfig) => {
      try {
        await updateSystemConfig(data as Record<string, unknown>)
        await fetchAll()
      } catch (err: any) {
        setError(err.message || 'Failed to save system config')
      }
    },
    [fetchAll]
  )

  // ── Config name lookup ──
  const configNameMap = new Map(configs.map(c => [c._id, c.displayName]))

  return (
    <div className="container">
      <div className="row">
        <div className="col-md-12">
          <AdminNav currentPath="/admin/ai-models" />

          <h2 style={{ marginBottom: '20px' }}>AI Model Management</h2>

          {error && (
            <OLNotification
              type="error"
              content={error}
              isDismissible
              onDismiss={() => setError(null)}
            />
          )}

          {/* Tab Navigation */}
          <ul className="nav nav-tabs" style={{ marginBottom: '20px' }}>
            <li className={activeTab === 'configs' ? 'active' : ''}>
              <a
                href="#"
                onClick={e => {
                  e.preventDefault()
                  setActiveTab('configs')
                }}
              >
                Model Configs
              </a>
            </li>
            <li className={activeTab === 'slots' ? 'active' : ''}>
              <a
                href="#"
                onClick={e => {
                  e.preventDefault()
                  setActiveTab('slots')
                }}
              >
                Model Slots
              </a>
            </li>
            <li className={activeTab === 'system' ? 'active' : ''}>
              <a
                href="#"
                onClick={e => {
                  e.preventDefault()
                  setActiveTab('system')
                }}
              >
                System Settings
              </a>
            </li>
          </ul>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px' }}>
              <OLSpinner size="lg" />
            </div>
          ) : (
            <>
              {activeTab === 'configs' && (
                <ConfigsTab
                  configs={configs}
                  onAdd={() => {
                    setEditingConfig(null)
                    setShowConfigModal(true)
                  }}
                  onEdit={cfg => {
                    setEditingConfig(cfg)
                    setShowConfigModal(true)
                  }}
                  onDelete={handleDeleteConfig}
                />
              )}
              {activeTab === 'slots' && (
                <SlotsTab
                  slots={slots}
                  configNameMap={configNameMap}
                  onAdd={() => {
                    setEditingSlot(null)
                    setShowSlotModal(true)
                  }}
                  onEdit={slot => {
                    setEditingSlot(slot)
                    setShowSlotModal(true)
                  }}
                  onDelete={handleDeleteSlot}
                />
              )}
              {activeTab === 'system' && (
                <SystemTab
                  systemCfg={systemCfg}
                  slots={slots}
                  onSave={handleSaveSystem}
                />
              )}
            </>
          )}

          {showConfigModal && (
            <ConfigFormModal
              config={editingConfig}
              onSave={handleSaveConfig}
              onClose={() => {
                setShowConfigModal(false)
                setEditingConfig(null)
              }}
            />
          )}
          {showSlotModal && (
            <SlotFormModal
              slot={editingSlot}
              configs={configs}
              onSave={handleSaveSlot}
              onClose={() => {
                setShowSlotModal(false)
                setEditingSlot(null)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Configs Tab ──

function ConfigsTab({
  configs,
  onAdd,
  onEdit,
  onDelete,
}: {
  configs: ModelConfig[]
  onAdd: () => void
  onEdit: (cfg: ModelConfig) => void
  onDelete: (id: string) => void
}) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: '12px',
        }}
      >
        <OLButton variant="primary" onClick={onAdd}>
          Add Config
        </OLButton>
      </div>
      <table className="table table-hover">
        <thead>
          <tr>
            <th>Display Name</th>
            <th>Model</th>
            <th>API Base</th>
            <th>API Key</th>
            <th>Image</th>
            <th>Tokens</th>
            <th>Temp</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {configs.length === 0 ? (
            <tr>
              <td colSpan={9} style={{ textAlign: 'center' }}>
                No model configs found.
              </td>
            </tr>
          ) : (
            configs.map(cfg => (
              <tr key={cfg._id}>
                <td>{cfg.displayName}</td>
                <td>
                  <code>{cfg.model}</code>
                </td>
                <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {cfg.apiBase}
                </td>
                <td>
                  <code>{maskApiKey(cfg.apiKey)}</code>
                </td>
                <td>{cfg.supportsImage ? 'Yes' : 'No'}</td>
                <td>{cfg.maxTokens ?? '-'}</td>
                <td>{cfg.temperature ?? '-'}</td>
                <td>
                  {cfg.enabled ? (
                    <OLBadge bg="success">Enabled</OLBadge>
                  ) : (
                    <OLBadge bg="secondary">Disabled</OLBadge>
                  )}
                </td>
                <td>
                  <OLButton
                    variant="secondary"
                    size="sm"
                    onClick={() => onEdit(cfg)}
                    style={{ marginRight: '4px' }}
                  >
                    Edit
                  </OLButton>
                  <OLButton
                    variant="danger"
                    size="sm"
                    onClick={() => onDelete(cfg._id)}
                  >
                    Delete
                  </OLButton>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  )
}

// ── Slots Tab ──

function SlotsTab({
  slots,
  configNameMap,
  onAdd,
  onEdit,
  onDelete,
}: {
  slots: ModelSlot[]
  configNameMap: Map<string, string>
  onAdd: () => void
  onEdit: (slot: ModelSlot) => void
  onDelete: (slug: string) => void
}) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: '12px',
        }}
      >
        <OLButton variant="primary" onClick={onAdd}>
          Add Slot
        </OLButton>
      </div>
      <table className="table table-hover">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Label</th>
            <th>Model Config</th>
            <th>Icon</th>
            <th>Sort</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {slots.length === 0 ? (
            <tr>
              <td colSpan={7} style={{ textAlign: 'center' }}>
                No model slots found.
              </td>
            </tr>
          ) : (
            slots.map(slot => (
              <tr key={slot._id}>
                <td>
                  <code>{slot.slug}</code>
                </td>
                <td>{slot.label}</td>
                <td>{configNameMap.get(slot.modelConfigId) || slot.modelConfigId}</td>
                <td>{slot.icon || '-'}</td>
                <td>{slot.sortOrder ?? 0}</td>
                <td>
                  {slot.enabled ? (
                    <OLBadge bg="success">Enabled</OLBadge>
                  ) : (
                    <OLBadge bg="secondary">Disabled</OLBadge>
                  )}
                </td>
                <td>
                  <OLButton
                    variant="secondary"
                    size="sm"
                    onClick={() => onEdit(slot)}
                    style={{ marginRight: '4px' }}
                  >
                    Edit
                  </OLButton>
                  <OLButton
                    variant="danger"
                    size="sm"
                    onClick={() => onDelete(slot.slug)}
                  >
                    Delete
                  </OLButton>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  )
}

// ── System Tab ──

function SystemTab({
  systemCfg,
  slots,
  onSave,
}: {
  systemCfg: SystemConfig
  slots: ModelSlot[]
  onSave: (data: SystemConfig) => void
}) {
  const [defaultSlot, setDefaultSlot] = useState(systemCfg.defaultSlot || '')
  const [quickEdit, setQuickEdit] = useState(
    systemCfg.featureBindings?.quickEdit || ''
  )
  const [autocomplete, setAutocomplete] = useState(
    systemCfg.featureBindings?.autocomplete || ''
  )
  const [digestModel, setDigestModel] = useState(
    systemCfg.featureBindings?.digestModel || ''
  )

  useEffect(() => {
    setDefaultSlot(systemCfg.defaultSlot || '')
    setQuickEdit(systemCfg.featureBindings?.quickEdit || '')
    setAutocomplete(systemCfg.featureBindings?.autocomplete || '')
    setDigestModel(systemCfg.featureBindings?.digestModel || '')
  }, [systemCfg])

  const enabledSlots = slots.filter(s => s.enabled)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSave({
      defaultSlot,
      featureBindings: {
        quickEdit,
        autocomplete,
        digestModel,
      },
    })
  }

  const slotSelect = (
    label: string,
    value: string,
    onChange: (v: string) => void
  ) => (
    <div className="form-group" style={{ marginBottom: '12px' }}>
      <label>{label}</label>
      <select
        className="form-control"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">-- None --</option>
        {enabledSlots.map(s => (
          <option key={s.slug} value={s.slug}>
            {s.label} ({s.slug})
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: '600px' }}>
      {slotSelect('Default Slot', defaultSlot, setDefaultSlot)}
      <h4 style={{ marginTop: '24px', marginBottom: '12px' }}>
        Feature Bindings
      </h4>
      {slotSelect('Quick Edit', quickEdit, setQuickEdit)}
      {slotSelect('Autocomplete', autocomplete, setAutocomplete)}
      {slotSelect('Digest Model', digestModel, setDigestModel)}
      <div style={{ marginTop: '16px' }}>
        <OLButton variant="primary" type="submit">
          Save System Settings
        </OLButton>
      </div>
    </form>
  )
}
