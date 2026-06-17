import { useState } from 'react'
import { useAutocompleteStatus } from '../context/autocomplete-status-context'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import MaterialIcon from '@/shared/components/material-icon'
import classNames from 'classnames'
import getMeta from '@/utils/meta'
import CompletionRulesEditor from './completion-rules-editor'

export function CompletionStatusIndicator() {
  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false

  if (!aiEnabled) return null

  return <CompletionStatusIndicatorInner />
}

function CompletionStatusIndicatorInner() {
  const { status, source } = useAutocompleteStatus()
  const [showRulesEditor, setShowRulesEditor] = useState(false)

  const isActive = status === 'loading' || status === 'streaming'
  let tooltipText: string
  if (isActive && source === 'enhanced') {
    tooltipText = '强大补全中...'
  } else if (isActive) {
    tooltipText = '自动补全中...'
  } else {
    tooltipText = '补全状态 (Alt+/ 触发强大补全)'
  }

  return (
    <>
      <OLTooltip
        id="toolbar-completion-status"
        description={tooltipText}
        overlayProps={{ placement: 'bottom' }}
      >
        <button
          className={classNames('toolbar-completion-status', {
            'toolbar-completion-status-active': isActive,
            'toolbar-completion-status-enhanced': isActive && source === 'enhanced',
          })}
          onClick={() => setShowRulesEditor(prev => !prev)}
          aria-label="补全状态"
        >
          <MaterialIcon type="edit_note" className="toolbar-completion-status-icon" />
        </button>
      </OLTooltip>
      <CompletionRulesEditor
        isOpen={showRulesEditor}
        onClose={() => setShowRulesEditor(false)}
      />
    </>
  )
}
