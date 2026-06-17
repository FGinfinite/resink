import { getJSON, postJSON, deleteJSON } from '@/infrastructure/fetch-json'
import type {
  AdminUser,
  AdminUserListResponse,
  AdminProject,
  DeletedProject,
  AuditLogResponse,
} from '../types/admin-panel-types'

export async function fetchUsers(
  page: number,
  limit: number,
  query: string
): Promise<AdminUserListResponse> {
  return getJSON<AdminUserListResponse>(
    `/admin/api/users?page=${page}&limit=${limit}&query=${encodeURIComponent(query)}`
  )
}

export async function fetchUser(userId: string): Promise<AdminUser> {
  return getJSON<AdminUser>(`/admin/api/users/${userId}`)
}

export async function toggleAdmin(userId: string): Promise<void> {
  return postJSON(`/admin/api/users/${userId}/toggle-admin`)
}

export async function suspendUser(userId: string): Promise<void> {
  return postJSON(`/admin/api/users/${userId}/suspend`)
}

export async function unsuspendUser(userId: string): Promise<void> {
  return postJSON(`/admin/api/users/${userId}/unsuspend`)
}

export async function deleteUser(userId: string): Promise<void> {
  return deleteJSON(`/admin/api/users/${userId}`)
}

export async function fetchUserProjects(
  userId: string
): Promise<{ projects: AdminProject[] }> {
  return getJSON<{ projects: AdminProject[] }>(
    `/admin/api/users/${userId}/projects`
  )
}

export async function transferProjectOwnership(
  userId: string,
  projectId: string,
  targetUserId: string
): Promise<void> {
  return postJSON(
    `/admin/api/users/${userId}/projects/${projectId}/transfer`,
    { body: { targetUserId } }
  )
}

export async function fetchDeletedProjects(
  userId: string
): Promise<{ deletedProjects: DeletedProject[] }> {
  return getJSON<{ deletedProjects: DeletedProject[] }>(
    `/admin/api/users/${userId}/deleted-projects`
  )
}

export async function restoreDeletedProject(
  userId: string,
  projectId: string
): Promise<void> {
  return postJSON(
    `/admin/api/users/${userId}/deleted-projects/${projectId}/restore`
  )
}

export async function fetchAuditLog(
  userId: string,
  page: number,
  limit: number
): Promise<AuditLogResponse> {
  return getJSON<AuditLogResponse>(
    `/admin/api/users/${userId}/audit-log?page=${page}&limit=${limit}`
  )
}
