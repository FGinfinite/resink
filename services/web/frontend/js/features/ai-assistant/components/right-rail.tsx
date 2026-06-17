import { useTranslation } from 'react-i18next'
import { Panel } from 'react-resizable-panels'
import { HorizontalResizeHandle } from '@/features/ide-react/components/resize/horizontal-resize-handle'
import { HorizontalToggler } from '@/features/ide-react/components/resize/horizontal-toggler'
import { useOptionalAIRailContext } from '../context/ai-rail-context'
import { AIAssistantPane } from '@/features/ai-assistant'
import classNames from 'classnames'
import MaterialIcon from '@/shared/components/material-icon'
import OLTooltip from '@/shared/components/ol/ol-tooltip'
import { useLayoutContext } from '@/shared/context/layout-context'

type RightRailLayoutProps = {
  onResizing?: (resizing: boolean) => void
}

export function RightRailLayout({ onResizing }: RightRailLayoutProps) {
  const aiRailCtx = useOptionalAIRailContext()
  const { t } = useTranslation()
  const { view } = useLayoutContext()

  const isHistoryView = view === 'history'

  // Don't render if AI is disabled or panel is on the left side
  if (!aiRailCtx || aiRailCtx.side !== 'right') return null

  const {
    rightRailIsOpen,
    toggleRightRailPane,
    rightRailPanelRef,
    handleRightRailExpand,
    handleRightRailCollapse,
  } = aiRailCtx

  return (
    <>
      <HorizontalResizeHandle
        resizable={rightRailIsOpen}
        onDragging={onResizing}
        hitAreaMargins={{ coarse: 0, fine: 0 }}
        className={classNames({ hidden: isHistoryView })}
      >
        <HorizontalToggler
          id="ide-right-rail-panel"
          togglerType="east"
          isOpen={rightRailIsOpen}
          setIsOpen={(open) => {
            if (open) {
              handleRightRailExpand()
              rightRailPanelRef.current?.expand()
            } else {
              handleRightRailCollapse()
              rightRailPanelRef.current?.collapse()
            }
          }}
          tooltipWhenOpen={t('tooltip_hide_ai_panel', 'Hide AI panel')}
          tooltipWhenClosed={t('tooltip_show_ai_panel', 'Show AI panel')}
        />
      </HorizontalResizeHandle>
      <Panel
        id="ide-right-rail-panel"
        order={3}
        collapsible
        collapsedSize={0}
        defaultSize={rightRailIsOpen ? 20 : 0}
        minSize={5}
        maxSize={80}
        ref={rightRailPanelRef}
        onExpand={handleRightRailExpand}
        onCollapse={handleRightRailCollapse}
        className={classNames({ hidden: isHistoryView })}
      >
        <div className="ide-right-rail-content-wrapper">
          <div className="ide-rail-content">
            <AIAssistantPane />
          </div>
          <nav
            className={classNames('ide-right-rail', { hidden: isHistoryView })}
            aria-label={t('ai_assistant', 'AI Assistant')}
          >
            <OLTooltip
              id="right-rail-ai-tab"
              description={t('ai_assistant', 'AI Assistant')}
              overlayProps={{ delay: 0, placement: 'left' }}
            >
              <button
                className={classNames('ide-rail-tab-link', {
                  'open-rail': rightRailIsOpen,
                })}
                onClick={toggleRightRailPane}
                aria-label={t('ai_assistant', 'AI Assistant')}
              >
                <MaterialIcon
                  type="smart_toy"
                  className="ide-rail-tab-link-icon"
                  unfilled={!rightRailIsOpen}
                  accessibilityLabel={t('ai_assistant', 'AI Assistant')}
                />
              </button>
            </OLTooltip>
          </nav>
        </div>
      </Panel>
    </>
  )
}
