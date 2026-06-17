import {
  deleteJSON,
  getJSON,
  postJSON,
  putJSON,
} from '@/infrastructure/fetch-json'

export async function listRuntimeConfigServices() {
  return getJSON<{ services: string[] }>('/admin/api/config/services')
}

export async function listRuntimeConfigEntries(service: string) {
  return getJSON<{ entries: RuntimeConfigEntry[] }>(
    `/admin/api/config/${encodeURIComponent(service)}/entries`
  )
}

export async function listRuntimeConfigRevisions(service: string, key: string) {
  return getJSON<{ revisions: RuntimeConfigRevision[] }>(
    `/admin/api/config/${encodeURIComponent(service)}/revisions/${encodeURIComponent(key)}`
  )
}

export async function updateRuntimeConfigValue(
  service: string,
  key: string,
  body: Record<string, unknown>
) {
  return putJSON(
    `/admin/api/config/${encodeURIComponent(service)}/values/${encodeURIComponent(key)}`,
    { body }
  )
}

export async function resetRuntimeConfigValue(
  service: string,
  key: string,
  body: Record<string, unknown>
) {
  return deleteJSON(
    `/admin/api/config/${encodeURIComponent(service)}/values/${encodeURIComponent(key)}`,
    { body }
  )
}

export async function rollbackRuntimeConfigValue(
  service: string,
  key: string,
  body: Record<string, unknown>
) {
  return postJSON(
    `/admin/api/config/${encodeURIComponent(service)}/revisions/${encodeURIComponent(key)}/rollback`,
    { body }
  )
}

export type RuntimeConfigEntry = {
  key: string
  service: string
  label: string
  category: string
  description: string
  type: string
  enumValues: string[]
  envAliases: string[]
  reloadStrategy: string
  runtimeEditable: boolean
  defaultValue: unknown
  resolvedValue: unknown
  source: string
  runtimeVersion: number | null
  updatedAt: string | null
  updatedBy: string | null
  comment: string
}

export type RuntimeConfigRevision = {
  version: number
  action: string
  value: unknown
  normalizedValue: unknown
  previousValue: unknown
  previousVersion: number | null
  updatedBy: string | null
  comment: string
  createdAt: string
}
