import React, { useState, useEffect, useCallback } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import OLNotification from '@/shared/components/ol/ol-notification'
import TransferOwnershipModal from './transfer-ownership-modal'
import { fetchUserProjects, transferProjectOwnership } from '../api/admin-api'
import type { AdminProject } from '../types/admin-panel-types'

interface UserProjectsTabProps {
  userId: string
  setNotification: (n: { type: 'success' | 'error'; message: string } | null) => void
}

export default function UserProjectsTab({
  userId,
  setNotification,
}: UserProjectsTabProps) {
  const [projects, setProjects] = useState<AdminProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transferProject, setTransferProject] = useState<AdminProject | null>(
    null
  )

  const loadProjects = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchUserProjects(userId)
      .then(data => {
        setProjects(data.projects)
        setLoading(false)
      })
      .catch(err => {
        setError(err.message || 'Failed to fetch projects')
        setLoading(false)
      })
  }, [userId])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  const handleTransfer = async (targetUserId: string) => {
    if (!transferProject) return
    try {
      await transferProjectOwnership(userId, transferProject._id, targetUserId)
      setNotification({
        type: 'success',
        message: `Project "${transferProject.name}" transferred successfully.`,
      })
      setTransferProject(null)
      loadProjects()
    } catch (err: any) {
      setNotification({
        type: 'error',
        message: err.message || 'Failed to transfer project.',
      })
      setTransferProject(null)
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
      <h4>Projects</h4>
      <table className="table table-hover">
        <thead>
          <tr>
            <th>Project Name</th>
            <th>Last Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ textAlign: 'center' }}>
                No projects found.
              </td>
            </tr>
          ) : (
            projects.map(project => (
              <tr key={project._id}>
                <td>{project.name}</td>
                <td>
                  {project.lastUpdated
                    ? new Date(project.lastUpdated).toLocaleString()
                    : '-'}
                </td>
                <td>
                  <OLButton
                    variant="secondary"
                    size="sm"
                    onClick={() => setTransferProject(project)}
                  >
                    Transfer
                  </OLButton>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {transferProject && (
        <TransferOwnershipModal
          show={transferProject !== null}
          projectName={transferProject.name}
          onConfirm={handleTransfer}
          onHide={() => setTransferProject(null)}
        />
      )}
    </div>
  )
}
