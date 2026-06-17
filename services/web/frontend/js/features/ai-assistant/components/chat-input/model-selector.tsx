import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import type { ModelSlotInfo } from '../../types/ai-types'

interface ModelSelectorProps {
  selectedSlot: string | null
  onSlotChange: (slug: string) => void
  availableSlots: ModelSlotInfo[]
  disabled?: boolean
}

export default function ModelSelector({
  selectedSlot,
  onSlotChange,
  availableSlots,
  disabled = false,
}: ModelSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const selected = availableSlots.find(s => s.slug === selectedSlot)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  const handleSelect = useCallback(
    (slug: string) => {
      onSlotChange(slug)
      setOpen(false)
    },
    [onSlotChange]
  )

  if (availableSlots.length === 0) return null

  return (
    <div className="ai-model-selector" ref={containerRef}>
      <button
        type="button"
        className="ai-model-selector-trigger"
        onClick={() => setOpen(prev => !prev)}
        disabled={disabled}
        aria-label={t('select_model', 'Select model')}
      >
        {selected?.icon && <MaterialIcon type={selected.icon} />}
        <span>{selected?.label || t('select_model', 'Select model')}</span>
        <MaterialIcon type={open ? 'expand_less' : 'expand_more'} />
      </button>

      {open && (
        <div className="ai-model-selector-dropdown">
          {availableSlots.map(slot => (
            <button
              key={slot.slug}
              type="button"
              className={`ai-model-selector-option${slot.slug === selectedSlot ? ' selected' : ''}`}
              onClick={() => handleSelect(slot.slug)}
            >
              {slot.icon && <MaterialIcon type={slot.icon} />}
              <div>
                <div className="ai-model-option-label">{slot.label}</div>
                {slot.description && (
                  <div className="ai-model-option-desc">{slot.description}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
