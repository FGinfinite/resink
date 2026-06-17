import React, { useState } from 'react'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLForm from '@/shared/components/ol/ol-form'
import OLFormControl from '@/shared/components/ol/ol-form-control'

interface TransferOwnershipModalProps {
  show: boolean
  projectName: string
  onConfirm: (targetUserId: string) => Promise<void>
  onHide: () => void
}

export default function TransferOwnershipModal({
  show,
  projectName,
  onConfirm,
  onHide,
}: TransferOwnershipModalProps) {
  const [targetUserId, setTargetUserId] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!targetUserId.trim()) return
    setLoading(true)
    try {
      await onConfirm(targetUserId.trim())
      setTargetUserId('')
    } finally {
      setLoading(false)
    }
  }

  const handleHide = () => {
    setTargetUserId('')
    onHide()
  }

  return (
    <OLModal show={show} onHide={handleHide}>
      <OLModalHeader closeButton>
        <OLModalTitle>Transfer Project Ownership</OLModalTitle>
      </OLModalHeader>
      <OLForm onSubmit={handleSubmit}>
        <OLModalBody>
          <p>
            Transfer ownership of <strong>{projectName}</strong> to another
            user.
          </p>
          <div className="form-group">
            <label htmlFor="target-user-id">Target User Email or ID</label>
            <OLFormControl
              id="target-user-id"
              type="text"
              placeholder="Enter user email or ID"
              value={targetUserId}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setTargetUserId(e.target.value)
              }
              disabled={loading}
            />
          </div>
        </OLModalBody>
        <OLModalFooter>
          <OLButton variant="secondary" onClick={handleHide} disabled={loading}>
            Cancel
          </OLButton>
          <OLButton
            variant="primary"
            type="submit"
            isLoading={loading}
            loadingLabel="Transferring..."
            disabled={loading || !targetUserId.trim()}
          >
            Transfer
          </OLButton>
        </OLModalFooter>
      </OLForm>
    </OLModal>
  )
}
