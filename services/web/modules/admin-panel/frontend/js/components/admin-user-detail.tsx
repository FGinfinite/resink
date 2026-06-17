import React, { useState, useEffect, useCallback } from 'react'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import getMeta from '@/utils/meta'
import { fetchUser } from '../api/admin-api'
import type { AdminUser } from '../types/admin-panel-types'
import AdminNav from './admin-nav'
import UserInfoTab from './user-info-tab'
import UserProjectsTab from './user-projects-tab'
import UserDeletedProjectsTab from './user-deleted-projects-tab'
import UserAuditLogTab from './user-audit-log-tab'

type TabKey = 'info' | 'projects' | 'deleted-projects' | 'audit-log'

export default function AdminUserDetail() {
  const userId = getMeta('ol-adminUserId')
  const [user, setUser] = useState<AdminUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('info')
  const [notification, setNotification] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const loadUser = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchUser(userId)
      .then(data => {
        setUser(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message || 'Failed to fetch user')
        setLoading(false)
      })
  }, [userId])

  useEffect(() => {
    loadUser()
  }, [loadUser])

  const handleUserUpdated = useCallback(() => {
    loadUser()
  }, [loadUser])

  if (loading) {
    return (
      <div className="container">
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <OLSpinner size="lg" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container">
        <OLNotification type="error" content={error} />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="container">
        <OLNotification type="error" content="User not found." />
      </div>
    )
  }

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'info', label: 'Info' },
    { key: 'projects', label: 'Projects' },
    { key: 'deleted-projects', label: 'Deleted Projects' },
    { key: 'audit-log', label: 'Audit Log' },
  ]

  return (
    <div className="container">
      <div className="row">
        <div className="col-md-12">
          <AdminNav currentPath="/admin/users" />

          <div style={{ marginBottom: '10px' }}>
            <a href="/admin/users">&laquo; Back to Users</a>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <h2>
              {user.email}{' '}
              {user.first_name || user.last_name
                ? `(${[user.first_name, user.last_name].filter(Boolean).join(' ')})`
                : ''}
            </h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              {user.isAdmin && <OLBadge bg="info">Admin</OLBadge>}
              {user.suspended && <OLBadge bg="danger">Suspended</OLBadge>}
            </div>
          </div>

          {notification && (
            <OLNotification
              type={notification.type}
              content={notification.message}
              isDismissible
              onDismiss={() => setNotification(null)}
            />
          )}

          <ul className="nav nav-tabs" style={{ marginBottom: '20px' }}>
            {tabs.map(tab => (
              <li key={tab.key} className={activeTab === tab.key ? 'active' : ''}>
                <button
                  className="btn btn-link"
                  style={{
                    borderBottom:
                      activeTab === tab.key ? '2px solid #428bca' : 'none',
                    borderRadius: 0,
                    color: activeTab === tab.key ? '#428bca' : '#555',
                  }}
                  onClick={() => setActiveTab(tab.key)}
                >
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>

          {activeTab === 'info' && (
            <UserInfoTab
              userId={userId}
              user={user}
              onUserUpdated={handleUserUpdated}
              setNotification={setNotification}
            />
          )}
          {activeTab === 'projects' && (
            <UserProjectsTab
              userId={userId}
              setNotification={setNotification}
            />
          )}
          {activeTab === 'deleted-projects' && (
            <UserDeletedProjectsTab
              userId={userId}
              setNotification={setNotification}
            />
          )}
          {activeTab === 'audit-log' && (
            <UserAuditLogTab userId={userId} />
          )}
        </div>
      </div>
    </div>
  )
}
