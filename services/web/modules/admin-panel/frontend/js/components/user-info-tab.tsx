import React, { useState } from 'react'
import OLButton from '@/shared/components/ol/ol-button'
import { useLocation } from '@/shared/hooks/use-location'
import ConfirmActionModal from './confirm-action-modal'
import {
  toggleAdmin,
  suspendUser,
  unsuspendUser,
  deleteUser,
} from '../api/admin-api'
import type { AdminUser } from '../types/admin-panel-types'

interface UserInfoTabProps {
  userId: string
  user: AdminUser
  onUserUpdated: () => void
  setNotification: (n: { type: 'success' | 'error'; message: string } | null) => void
}

type ModalAction = 'toggleAdmin' | 'suspend' | 'unsuspend' | 'delete' | null

export default function UserInfoTab({
  userId,
  user,
  onUserUpdated,
  setNotification,
}: UserInfoTabProps) {
  const [modalAction, setModalAction] = useState<ModalAction>(null)
  const { assign } = useLocation()

  const modalConfigs: Record<
    Exclude<ModalAction, null>,
    {
      title: string
      message: string
      confirmLabel: string
      confirmVariant: 'danger' | 'primary'
      action: () => Promise<void>
      successMessage: string
    }
  > = {
    toggleAdmin: {
      title: user.isAdmin ? 'Remove Admin' : 'Make Admin',
      message: user.isAdmin
        ? `Remove admin privileges from ${user.email}?`
        : `Grant admin privileges to ${user.email}?`,
      confirmLabel: user.isAdmin ? 'Remove Admin' : 'Make Admin',
      confirmVariant: user.isAdmin ? 'danger' : 'primary',
      action: () => toggleAdmin(userId),
      successMessage: user.isAdmin
        ? 'Admin privileges removed.'
        : 'Admin privileges granted.',
    },
    suspend: {
      title: 'Suspend User',
      message: `Suspend user ${user.email}? They will not be able to log in.`,
      confirmLabel: 'Suspend',
      confirmVariant: 'danger',
      action: () => suspendUser(userId),
      successMessage: 'User suspended.',
    },
    unsuspend: {
      title: 'Unsuspend User',
      message: `Unsuspend user ${user.email}? They will be able to log in again.`,
      confirmLabel: 'Unsuspend',
      confirmVariant: 'primary',
      action: () => unsuspendUser(userId),
      successMessage: 'User unsuspended.',
    },
    delete: {
      title: 'Delete User',
      message: `Permanently delete user ${user.email}? This action cannot be undone.`,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
      action: () => deleteUser(userId),
      successMessage: 'User deleted.',
    },
  }

  const handleConfirm = async () => {
    if (!modalAction) return
    const config = modalConfigs[modalAction]
    try {
      await config.action()
      setNotification({ type: 'success', message: config.successMessage })
      setModalAction(null)
      if (modalAction === 'delete') {
        assign('/admin/users')
      } else {
        onUserUpdated()
      }
    } catch (err: any) {
      setNotification({
        type: 'error',
        message: err.message || 'Action failed.',
      })
      setModalAction(null)
    }
  }

  const currentConfig = modalAction ? modalConfigs[modalAction] : null
  const features = user.features
  const featureEntries = features ? Object.entries(features) : []

  return (
    <div>
      <h4>User Information</h4>
      <table className="table">
        <tbody>
          <tr>
            <th>Email</th>
            <td>{user.email}</td>
          </tr>
          <tr>
            <th>First Name</th>
            <td>{user.first_name || '-'}</td>
          </tr>
          <tr>
            <th>Last Name</th>
            <td>{user.last_name || '-'}</td>
          </tr>
          <tr>
            <th>Created</th>
            <td>
              {user.createdAt
                ? new Date(user.createdAt).toLocaleString()
                : '-'}
            </td>
          </tr>
          <tr>
            <th>Last Login</th>
            <td>
              {user.lastLoggedIn
                ? new Date(user.lastLoggedIn).toLocaleString()
                : '-'}
            </td>
          </tr>
          <tr>
            <th>Login Count</th>
            <td>{user.loginCount ?? '-'}</td>
          </tr>
          <tr>
            <th>Last Login IP</th>
            <td>{user.lastLoginIp || '-'}</td>
          </tr>
        </tbody>
      </table>

      {featureEntries.length > 0 && (
        <>
          <h4>Features</h4>
          <table className="table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {featureEntries.map(([key, value]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4>Actions</h4>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <OLButton
          variant="secondary"
          onClick={() => setModalAction('toggleAdmin')}
        >
          {user.isAdmin ? 'Remove Admin' : 'Make Admin'}
        </OLButton>
        {user.suspended ? (
          <OLButton
            variant="primary"
            onClick={() => setModalAction('unsuspend')}
          >
            Unsuspend
          </OLButton>
        ) : (
          <OLButton
            variant="danger"
            onClick={() => setModalAction('suspend')}
          >
            Suspend
          </OLButton>
        )}
        <OLButton variant="danger" onClick={() => setModalAction('delete')}>
          Delete User
        </OLButton>
      </div>

      {currentConfig && (
        <ConfirmActionModal
          show={modalAction !== null}
          title={currentConfig.title}
          message={currentConfig.message}
          confirmLabel={currentConfig.confirmLabel}
          confirmVariant={currentConfig.confirmVariant}
          onConfirm={handleConfirm}
          onHide={() => setModalAction(null)}
        />
      )}
    </div>
  )
}
