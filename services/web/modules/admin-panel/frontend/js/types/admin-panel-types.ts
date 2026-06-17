export interface AdminUser {
  _id: string
  email: string
  first_name?: string
  last_name?: string
  isAdmin?: boolean
  suspended?: boolean
  createdAt?: string
  lastLoggedIn?: string
  loginCount?: number
  lastLoginIp?: string
  features?: Record<string, unknown>
}

export interface AdminUserListResponse {
  users: AdminUser[]
  hasMore: boolean
}

export interface AdminProject {
  _id: string
  name: string
  lastUpdated?: string
  owner_ref?: string
}

export interface DeletedProject {
  _id: string
  project: {
    _id: string
    name: string
  }
  deleterData: {
    deletedAt: string
  }
}

export interface AuditLogEntry {
  _id: string
  operation: string
  initiatorId?: string
  ipAddress?: string
  info?: Record<string, unknown>
  timestamp: string
}

export interface AuditLogResponse {
  entries: AuditLogEntry[]
  totalEntries: number
  totalPages: number
}
