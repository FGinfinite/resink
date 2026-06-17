import React, { useState, useEffect, useCallback } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLBadge from '@/shared/components/ol/ol-badge'
import { fetchUsers } from '../api/admin-api'
import AdminNav from './admin-nav'
import type { AdminUser } from '../types/admin-panel-types'

const USERS_PER_PAGE = 20

export default function AdminUsersList() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)
  const [query, setQuery] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchUsers(page, USERS_PER_PAGE, query)
      .then(data => {
        if (!cancelled) {
          setUsers(data.users)
          setHasMore(data.hasMore ?? false)
          setLoading(false)
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err.message || 'Failed to fetch users')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [page, query])

  const handleSearch = useCallback(() => {
    setPage(1)
    setQuery(searchInput)
  }, [searchInput])

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSearch()
      }
    },
    [handleSearch]
  )

  return (
    <div className="container">
      <div className="row">
        <div className="col-md-12">
          <AdminNav currentPath="/admin/users" />

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px',
            }}
          >
            <h2>User Management</h2>
            <OLButton variant="primary" href="/admin/register">
              New User
            </OLButton>
          </div>

          <div
            style={{
              display: 'flex',
              gap: '8px',
              marginBottom: '20px',
            }}
          >
            <input
              type="text"
              className="form-control"
              placeholder="Search by email or name..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <OLButton variant="secondary" onClick={handleSearch}>
              Search
            </OLButton>
          </div>

          {error && (
            <OLNotification type="error" content={error} isDismissible />
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px' }}>
              <OLSpinner size="lg" />
            </div>
          ) : (
            <>
              <table className="table table-hover">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Admin</th>
                    <th>Suspended</th>
                    <th>Created</th>
                    <th>Last Login</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center' }}>
                        No users found.
                      </td>
                    </tr>
                  ) : (
                    users.map(user => (
                      <tr key={user._id}>
                        <td>
                          <a href={`/admin/users/${user._id}`}>{user.email}</a>
                        </td>
                        <td>
                          {[user.first_name, user.last_name]
                            .filter(Boolean)
                            .join(' ') || '-'}
                        </td>
                        <td>
                          {user.isAdmin && (
                            <OLBadge bg="info">Admin</OLBadge>
                          )}
                        </td>
                        <td>
                          {user.suspended && (
                            <OLBadge bg="danger">Suspended</OLBadge>
                          )}
                        </td>
                        <td>
                          {user.createdAt
                            ? new Date(user.createdAt).toLocaleDateString()
                            : '-'}
                        </td>
                        <td>
                          {user.lastLoggedIn
                            ? new Date(user.lastLoggedIn).toLocaleDateString()
                            : '-'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>

              {(page > 1 || hasMore) && (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    gap: '12px',
                    marginTop: '16px',
                  }}
                >
                  <OLButton
                    variant="secondary"
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                  >
                    Previous
                  </OLButton>
                  <span style={{ lineHeight: '38px' }}>Page {page}</span>
                  <OLButton
                    variant="secondary"
                    disabled={!hasMore}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Next
                  </OLButton>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
