import {
  getJSON,
  postJSON,
  putJSON,
  deleteJSON,
} from '@/infrastructure/fetch-json'

const BASE_URL = '/api/ai'

// Model Configs
export async function listConfigs() {
  return getJSON(`${BASE_URL}/admin/model-configs`)
}

export async function createConfig(data: Record<string, unknown>) {
  return postJSON(`${BASE_URL}/admin/model-configs`, { body: data })
}

export async function updateConfig(id: string, data: Record<string, unknown>) {
  return putJSON(`${BASE_URL}/admin/model-configs/${id}`, { body: data })
}

export async function deleteConfig(id: string) {
  return deleteJSON(`${BASE_URL}/admin/model-configs/${id}`)
}

// Model Slots
export async function listSlots() {
  return getJSON(`${BASE_URL}/admin/model-slots`)
}

export async function createSlot(data: Record<string, unknown>) {
  return postJSON(`${BASE_URL}/admin/model-slots`, { body: data })
}

export async function updateSlot(
  slug: string,
  data: Record<string, unknown>
) {
  return putJSON(`${BASE_URL}/admin/model-slots/${slug}`, { body: data })
}

export async function deleteSlot(slug: string) {
  return deleteJSON(`${BASE_URL}/admin/model-slots/${slug}`)
}

// System Config
export async function getSystemConfig() {
  return getJSON(`${BASE_URL}/admin/system-config`)
}

export async function updateSystemConfig(data: Record<string, unknown>) {
  return putJSON(`${BASE_URL}/admin/system-config`, { body: data })
}
