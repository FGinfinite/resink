import React, { useState, useEffect, useCallback } from 'react'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLNotification from '@/shared/components/ol/ol-notification'
import Pagination from '@/shared/components/pagination'
import { fetchAuditLog } from '../api/admin-api'
import type { AuditLogEntry } from '../types/admin-panel-types'

const AUDIT_LOG_PER_PAGE = 20

interface UserAuditLogTabProps {
  userId: string
}

export default function UserAuditLogTab({ userId }: UserAuditLogTabProps) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchAuditLog(userId, page, AUDIT_LOG_PER_PAGE)
      .then(data => {
        if (!cancelled) {
          setEntries(data.entries)
          setTotalPages(data.totalPages || 1)
          setLoading(false)
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err.message || 'Failed to fetch audit log')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [userId, page])

  const handlePageClick = useCallback(
    (_e: React.MouseEvent | React.SyntheticEvent, newPage: number) => {
      setPage(newPage)
    },
    []
  )

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <OLSpinner size="lg" />
      </div>
    )
  }

  if (error) {
    return <OLNotification type="error" content={error} isDismissible />
  }

  return (
    <div>
      <h4>Audit Log</h4>
      <table className="table table-hover">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Initiator ID</th>
            <th>IP Address</th>
            <th>Timestamp</th>
            <th>Info</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ textAlign: 'center' }}>
                No audit log entries found.
              </td>
            </tr>
          ) : (
            entries.map(entry => (
              <tr key={entry._id}>
                <td>{entry.operation}</td>
                <td>{entry.initiatorId || '-'}</td>
                <td>{entry.ipAddress || '-'}</td>
                <td>
                  {entry.timestamp
                    ? new Date(entry.timestamp).toLocaleString()
                    : '-'}
                </td>
                <td>
                  {entry.info ? (
                    <code
                      style={{
                        fontSize: '12px',
                        wordBreak: 'break-all',
                      }}
                    >
                      {JSON.stringify(entry.info)}
                    </code>
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {totalPages > 1 && (
        <Pagination
          currentPage={page}
          totalPages={totalPages}
          handlePageClick={handlePageClick}
        />
      )}
    </div>
  )
}
