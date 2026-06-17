import React, { useState, useEffect, useCallback } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLNotification from '@/shared/components/ol/ol-notification'
import ConfirmActionModal from './confirm-action-modal'
import { fetchDeletedProjects, restoreDeletedProject } from '../api/admin-api'
import type { DeletedProject } from '../types/admin-panel-types'

interface UserDeletedProjectsTabProps {
  userId: string
  setNotification: (n: { type: 'success' | 'error'; message: string } | null) => void
}

export default function UserDeletedProjectsTab({
  userId,
  setNotification,
}: UserDeletedProjectsTabProps) {
  const [deletedProjects, setDeletedProjects] = useState<DeletedProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<DeletedProject | null>(
    null
  )

  const loadDeletedProjects = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchDeletedProjects(userId)
      .then(data => {
        setDeletedProjects(data.deletedProjects)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message || 'Failed to fetch deleted projects')
        setLoading(false)
      })
  }, [userId])

  useEffect(() => {
    loadDeletedProjects()
  }, [loadDeletedProjects])

  const handleRestore = async () => {
    if (!restoreTarget) return
    try {
      await restoreDeletedProject(userId, restoreTarget.project._id)
      setNotification({
        type: 'success',
        message: `Project "${restoreTarget.project.name}" restored successfully.`,
      })
      setRestoreTarget(null)
      loadDeletedProjects()
    } catch (err: any) {
      setNotification({
        type: 'error',
        message: err.message || 'Failed to restore project.',
      })
      setRestoreTarget(null)
    }
  }

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
      <h4>Deleted Projects</h4>
      <table className="table table-hover">
        <thead>
          <tr>
            <th>Project Name</th>
            <th>Deleted At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {deletedProjects.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ textAlign: 'center' }}>
                No deleted projects found.
              </td>
            </tr>
          ) : (
            deletedProjects.map(dp => (
              <tr key={dp._id}>
                <td>{dp.project.name}</td>
                <td>
                  {dp.deleterData.deletedAt
                    ? new Date(dp.deleterData.deletedAt).toLocaleString()
                    : '-'}
                </td>
                <td>
                  <OLButton
                    variant="secondary"
                    size="sm"
                    onClick={() => setRestoreTarget(dp)}
                  >
                    Restore
                  </OLButton>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {restoreTarget && (
        <ConfirmActionModal
          show={restoreTarget !== null}
          title="Restore Project"
          message={`Restore project "${restoreTarget.project.name}"?`}
          confirmLabel="Restore"
          confirmVariant="primary"
          onConfirm={handleRestore}
          onHide={() => setRestoreTarget(null)}
        />
      )}
    </div>
  )
}
