import React, { useState } from 'react'
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'

interface ConfirmActionModalProps {
  show: boolean
  title: string
  message: string
  confirmLabel?: string
  confirmVariant?: 'danger' | 'primary'
  onConfirm: () => Promise<void>
  onHide: () => void
}

export default function ConfirmActionModal({
  show,
  title,
  message,
  confirmLabel = 'Confirm',
  confirmVariant = 'primary',
  onConfirm,
  onHide,
}: ConfirmActionModalProps) {
  const [loading, setLoading] = useState(false)

  const handleConfirm = async () => {
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
    }
  }

  return (
    <OLModal show={show} onHide={onHide}>
      <OLModalHeader closeButton>
        <OLModalTitle>{title}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p>{message}</p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide} disabled={loading}>
          Cancel
        </OLButton>
        <OLButton
          variant={confirmVariant}
          onClick={handleConfirm}
          isLoading={loading}
          loadingLabel="Processing..."
          disabled={loading}
        >
          {confirmLabel}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
