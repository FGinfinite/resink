import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import useWaitForI18n from '@/shared/hooks/use-wait-for-i18n'
import AdminNav from './admin-nav'
import {
  getRuntimeConfigCategoryLabel,
  getRuntimeConfigEntryDescription,
  getRuntimeConfigEntryLabel,
  getRuntimeConfigReloadStrategyLabel,
  getRuntimeConfigRevisionActionLabel,
  getRuntimeConfigServiceLabel,
  getRuntimeConfigSourceLabel,
} from './runtime-config-i18n'
import {
  listRuntimeConfigEntries,
  listRuntimeConfigRevisions,
  listRuntimeConfigServices,
  resetRuntimeConfigValue,
  rollbackRuntimeConfigValue,
  RuntimeConfigEntry,
  RuntimeConfigRevision,
  updateRuntimeConfigValue,
} from '../api/runtime-config-api'

function formatValue(value: unknown) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function parseValue(type: string, raw: string, checked: boolean) {
  if (type === 'boolean') return checked
  if (type === 'int') return Number.parseInt(raw, 10)
  if (type === 'float') return Number.parseFloat(raw)
  if (type === 'json') return raw.trim() ? JSON.parse(raw) : {}
  return raw
}

function ValueCell({ value }: { value: unknown }) {
  const { t } = useTranslation()
  const rendered = useMemo(() => formatValue(value), [value])
  return (
    <code
      style={{
        display: 'block',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxWidth: '320px',
      }}
    >
      {rendered || t('admin_runtime_config_not_available', { defaultValue: 'N/A' })}
    </code>
  )
}

function EditModal({
  entry,
  onClose,
  onSave,
}: {
  entry: RuntimeConfigEntry
  onClose: () => void
  onSave: (payload: { value: unknown; comment: string }) => void
}) {
  const { t } = useTranslation()
  const isBoolean = entry.type === 'boolean'
  const keyFieldId = `${entry.key}-key`
  const valueFieldId = `${entry.key}-value`
  const commentFieldId = `${entry.key}-comment`
  const [textValue, setTextValue] = useState(formatValue(entry.resolvedValue))
  const [checkedValue, setCheckedValue] = useState(Boolean(entry.resolvedValue))
  const [comment, setComment] = useState('')
  const translatedLabel = getRuntimeConfigEntryLabel(entry, t)
  const translatedDescription = getRuntimeConfigEntryDescription(entry, t)

  return (
    <div
      aria-label={`${translatedLabel} ${t('edit', { defaultValue: 'Edit' })}`}
      aria-modal="true"
      role="dialog"
      style={overlayStyle}
    >
      <div style={modalStyle}>
        <h4>{translatedLabel}</h4>
        <p style={{ color: '#666', marginBottom: '12px' }}>
          {translatedDescription}
        </p>
        <div className="form-group" style={{ marginBottom: '12px' }}>
          <label htmlFor={keyFieldId}>
            {t('admin_runtime_config_key', { defaultValue: 'Key' })}
          </label>
          <input
            id={keyFieldId}
            className="form-control"
            value={entry.key}
            disabled
          />
        </div>
        <div className="form-group" style={{ marginBottom: '12px' }}>
          <label htmlFor={valueFieldId}>
            {t('admin_runtime_config_value', { defaultValue: 'Value' })}
          </label>
          {isBoolean ? (
            <div>
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <input
                  id={valueFieldId}
                  checked={checkedValue}
                  type="checkbox"
                  onChange={event => setCheckedValue(event.target.checked)}
                />
                {t('enabled', { defaultValue: 'Enabled' })}
              </label>
            </div>
          ) : entry.type === 'enum' ? (
            <select
              id={valueFieldId}
              className="form-control"
              value={textValue}
              onChange={event => setTextValue(event.target.value)}
            >
              {(entry.enumValues || []).map(value => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : entry.type === 'json' ? (
            <textarea
              id={valueFieldId}
              className="form-control"
              rows={8}
              value={textValue}
              onChange={event => setTextValue(event.target.value)}
            />
          ) : (
            <input
              id={valueFieldId}
              className="form-control"
              type={entry.type === 'int' || entry.type === 'float' ? 'number' : 'text'}
              step={entry.type === 'float' ? '0.01' : '1'}
              value={textValue}
              onChange={event => setTextValue(event.target.value)}
            />
          )}
        </div>
        <div className="form-group" style={{ marginBottom: '16px' }}>
          <label htmlFor={commentFieldId}>
            {t('comment', { defaultValue: 'Comment' })}
          </label>
          <textarea
            id={commentFieldId}
            className="form-control"
            rows={3}
            value={comment}
            onChange={event => setComment(event.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <OLButton variant="secondary" onClick={onClose}>
            {t('cancel', { defaultValue: 'Cancel' })}
          </OLButton>
          <OLButton
            variant="primary"
            onClick={() =>
              onSave({
                value: parseValue(entry.type, textValue, checkedValue),
                comment,
              })
            }
          >
            {t('save', { defaultValue: 'Save' })}
          </OLButton>
        </div>
      </div>
    </div>
  )
}

function RevisionsModal({
  service,
  entry,
  revisions,
  onClose,
  onRollback,
}: {
  service: string
  entry: RuntimeConfigEntry
  revisions: RuntimeConfigRevision[]
  onClose: () => void
  onRollback: (version: number) => void
}) {
  const { i18n, t } = useTranslation()
  const translatedLabel = getRuntimeConfigEntryLabel(entry, t)

  return (
    <div
      aria-label={`${translatedLabel} ${t('history', { defaultValue: 'History' })}`}
      aria-modal="true"
      role="dialog"
      style={overlayStyle}
    >
      <div style={historyStyle}>
        <h4>
          {translatedLabel} {t('history', { defaultValue: 'History' })}
        </h4>
        <p style={{ color: '#666' }}>
          {service} / {entry.key}
        </p>
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <table className="table table-striped">
            <thead>
              <tr>
                <th>{t('admin_runtime_config_version', { defaultValue: 'Version' })}</th>
                <th>{t('admin_runtime_config_action', { defaultValue: 'Action' })}</th>
                <th>{t('admin_runtime_config_value', { defaultValue: 'Value' })}</th>
                <th>{t('comment', { defaultValue: 'Comment' })}</th>
                <th>{t('admin_runtime_config_at', { defaultValue: 'At' })}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {revisions.map(revision => (
                <tr key={`${revision.version}-${revision.createdAt}`}>
                  <td>{revision.version}</td>
                  <td>{getRuntimeConfigRevisionActionLabel(revision.action, t)}</td>
                  <td>
                    <ValueCell value={revision.normalizedValue} />
                  </td>
                  <td>
                    {revision.comment ||
                      t('admin_runtime_config_not_available', {
                        defaultValue: 'N/A',
                      })}
                  </td>
                  <td>
                    {revision.createdAt
                      ? new Date(revision.createdAt).toLocaleString(i18n.language)
                      : t('admin_runtime_config_not_available', {
                          defaultValue: 'N/A',
                        })}
                  </td>
                  <td>
                    <OLButton
                      variant="secondary"
                      size="sm"
                      onClick={() => onRollback(revision.version)}
                    >
                      {t('admin_runtime_config_rollback', {
                        defaultValue: 'Rollback',
                      })}
                    </OLButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <OLButton variant="secondary" onClick={onClose}>
            {t('close', { defaultValue: 'Close' })}
          </OLButton>
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1050,
}

const modalStyle: React.CSSProperties = {
  backgroundColor: '#fff',
  borderRadius: '6px',
  padding: '24px',
  width: '640px',
  maxWidth: 'calc(100vw - 48px)',
}

const historyStyle: React.CSSProperties = {
  ...modalStyle,
  width: '960px',
}

export default function RuntimeConfigManager() {
  const { t } = useTranslation()
  const { isReady: isI18nReady } = useWaitForI18n()
  const [services, setServices] = useState<string[]>([])
  const [service, setService] = useState('web')
  const [entries, setEntries] = useState<RuntimeConfigEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editingEntry, setEditingEntry] = useState<RuntimeConfigEntry | null>(null)
  const [historyEntry, setHistoryEntry] = useState<RuntimeConfigEntry | null>(null)
  const [revisions, setRevisions] = useState<RuntimeConfigRevision[]>([])

  const loadEntries = async (nextService = service) => {
    setLoading(true)
    setError('')
    try {
      const response = await listRuntimeConfigEntries(nextService)
      setEntries(response.entries)
    } catch (err: any) {
      setError(
        err.message ||
          t('admin_runtime_config_load_entries_failed', {
            defaultValue: 'Failed to load runtime config entries',
          })
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let isActive = true

    listRuntimeConfigServices()
      .then(response => {
        if (!isActive) {
          return
        }
        setServices(response.services)
        setService(currentService =>
          response.services.includes(currentService)
            ? currentService
            : response.services[0] || 'web'
        )
      })
      .catch((err: any) => {
        if (isActive) {
          setError(
            err.message ||
              t('admin_runtime_config_load_services_failed', {
                defaultValue: 'Failed to load config services',
              })
          )
        }
      })

    return () => {
      isActive = false
    }
  }, [t])

  useEffect(() => {
    let isActive = true

    setLoading(true)
    setError('')
    listRuntimeConfigEntries(service)
      .then(response => {
        if (isActive) {
          setEntries(response.entries)
        }
      })
      .catch((err: any) => {
        if (isActive) {
          setError(
            err.message ||
              t('admin_runtime_config_load_entries_failed', {
                defaultValue: 'Failed to load runtime config entries',
              })
          )
        }
      })
      .finally(() => {
        if (isActive) {
          setLoading(false)
        }
      })

    return () => {
      isActive = false
    }
  }, [service, t])

  const openHistory = async (entry: RuntimeConfigEntry) => {
    setHistoryEntry(entry)
    const response = await listRuntimeConfigRevisions(service, entry.key)
    setRevisions(response.revisions)
  }

  const handleSave = async (payload: { value: unknown; comment: string }) => {
    if (!editingEntry) return
    await updateRuntimeConfigValue(service, editingEntry.key, payload)
    setEditingEntry(null)
    await loadEntries(service)
  }

  const handleReset = async (entry: RuntimeConfigEntry) => {
    await resetRuntimeConfigValue(service, entry.key, {
      comment: t('admin_runtime_config_reset_comment', {
        defaultValue: 'Reset to default value',
      }),
    })
    await loadEntries(service)
  }

  const handleRollback = async (version: number) => {
    if (!historyEntry) return
    await rollbackRuntimeConfigValue(service, historyEntry.key, {
      version,
      comment: t('admin_runtime_config_rollback_comment', {
        version,
        defaultValue: 'Rollback to version __version__',
      }),
    })
    const response = await listRuntimeConfigRevisions(service, historyEntry.key)
    setRevisions(response.revisions)
    await loadEntries(service)
  }

  if (!isI18nReady) {
    return <OLSpinner />
  }

  return (
    <div>
      <h2 style={{ marginBottom: '20px' }}>
        {t('admin_runtime_config_title', { defaultValue: 'Runtime Config' })}
      </h2>

      <AdminNav currentPath="/admin/config" />

      <div
        style={{
          display: 'flex',
          gap: '8px',
          marginBottom: '20px',
          flexWrap: 'wrap',
        }}
      >
        {services.map(item => (
          <OLButton
            key={item}
            variant={item === service ? 'primary' : 'secondary'}
            onClick={() => setService(item)}
          >
            {getRuntimeConfigServiceLabel(item, t)}
          </OLButton>
        ))}
      </div>

      {error && (
        <OLNotification type="error" content={error} />
      )}

      {loading ? (
        <OLSpinner />
      ) : (
        <table className="table table-striped">
          <thead>
            <tr>
              <th>{t('admin_runtime_config_key', { defaultValue: 'Key' })}</th>
              <th>{t('admin_runtime_config_category', { defaultValue: 'Category' })}</th>
              <th>{t('admin_runtime_config_source', { defaultValue: 'Source' })}</th>
              <th>{t('admin_runtime_config_current', { defaultValue: 'Current' })}</th>
              <th>{t('admin_runtime_config_default', { defaultValue: 'Default' })}</th>
              <th>{t('admin_runtime_config_reload', { defaultValue: 'Reload' })}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => (
              <tr key={entry.key}>
                <td>
                  <strong>{getRuntimeConfigEntryLabel(entry, t)}</strong>
                  <div style={{ color: '#666', fontSize: '12px' }}>{entry.key}</div>
                </td>
                <td>{getRuntimeConfigCategoryLabel(entry.category, t)}</td>
                <td>{getRuntimeConfigSourceLabel(entry.source, t)}</td>
                <td>
                  <ValueCell value={entry.resolvedValue} />
                </td>
                <td>
                  <ValueCell value={entry.defaultValue} />
                </td>
                <td>{getRuntimeConfigReloadStrategyLabel(entry.reloadStrategy, t)}</td>
                <td>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <OLButton
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditingEntry(entry)}
                    >
                      {t('edit', { defaultValue: 'Edit' })}
                    </OLButton>
                    <OLButton
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        openHistory(entry).catch((err: any) => {
                          setError(
                            err.message ||
                              t('admin_runtime_config_load_revisions_failed', {
                                defaultValue: 'Failed to load config history',
                              })
                          )
                        })
                      }}
                    >
                      {t('history', { defaultValue: 'History' })}
                    </OLButton>
                    <OLButton
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        handleReset(entry).catch((err: any) => {
                          setError(
                            err.message ||
                              t('admin_runtime_config_reset_failed', {
                                defaultValue: 'Failed to reset config entry',
                              })
                          )
                        })
                      }}
                    >
                      {t('admin_runtime_config_reset', { defaultValue: 'Reset' })}
                    </OLButton>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editingEntry && (
        <EditModal
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onSave={payload => {
            handleSave(payload).catch((err: any) => {
              setError(
                err.message ||
                  t('admin_runtime_config_update_failed', {
                    defaultValue: 'Failed to update config entry',
                  })
              )
            })
          }}
        />
      )}

      {historyEntry && (
        <RevisionsModal
          service={service}
          entry={historyEntry}
          revisions={revisions}
          onClose={() => {
            setHistoryEntry(null)
            setRevisions([])
          }}
          onRollback={version => {
            handleRollback(version).catch((err: any) => {
              setError(
                err.message ||
                  t('admin_runtime_config_rollback_failed', {
                    defaultValue: 'Failed to rollback config entry',
                  })
              )
            })
          }}
        />
      )}
    </div>
  )
}
