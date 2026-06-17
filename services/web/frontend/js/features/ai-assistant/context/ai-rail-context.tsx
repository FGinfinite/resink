import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  FC,
} from 'react'
import { ImperativePanelHandle } from 'react-resizable-panels'
import usePersistedState from '@/shared/hooks/use-persisted-state'
import { useRailContext } from '@/features/ide-react/context/rail-context'
import getMeta from '@/utils/meta'

export type AIPanelSide = 'left' | 'right'

type AIRailContextType = {
  side: AIPanelSide
  setSide: (side: AIPanelSide) => void
  toggleSide: () => void
  rightRailIsOpen: boolean
  toggleRightRailPane: () => void
  openAIPanel: () => void
  rightRailPanelRef: React.RefObject<ImperativePanelHandle>
  handleRightRailExpand: () => void
  handleRightRailCollapse: () => void
}

const AIRailContext = createContext<AIRailContextType | undefined>(undefined)

export const AIRailProvider: FC<React.PropsWithChildren> = ({ children }) => {
  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false
  const { openTab } = useRailContext()

  const [side, setSideState] = usePersistedState<AIPanelSide>(
    'ai-panel-side',
    'left'
  )
  const [rightRailIsOpen, setRightRailIsOpen] = usePersistedState(
    'ai-right-rail-is-open',
    true
  )

  const rightRailPanelRef = useRef<ImperativePanelHandle>(null)

  const setSide = useCallback(
    (newSide: AIPanelSide) => {
      setSideState(newSide)
      // When switching to right, open the right rail panel
      if (newSide === 'right') {
        setRightRailIsOpen(true)
        // Expand panel after a tick to allow render
        requestAnimationFrame(() => {
          rightRailPanelRef.current?.expand()
        })
      }
    },
    [setSideState, setRightRailIsOpen]
  )

  const toggleSide = useCallback(() => {
    setSide(side === 'left' ? 'right' : 'left')
  }, [side, setSide])

  const toggleRightRailPane = useCallback(() => {
    setRightRailIsOpen(prev => {
      const next = !prev
      if (next) {
        rightRailPanelRef.current?.expand()
      } else {
        rightRailPanelRef.current?.collapse()
      }
      return next
    })
  }, [setRightRailIsOpen])

  const openAIPanel = useCallback(() => {
    if (side === 'left') {
      openTab('ai-assistant')
    } else {
      setRightRailIsOpen(true)
      rightRailPanelRef.current?.expand()
    }
  }, [side, openTab, setRightRailIsOpen])

  const handleRightRailExpand = useCallback(() => {
    setRightRailIsOpen(true)
  }, [setRightRailIsOpen])

  const handleRightRailCollapse = useCallback(() => {
    setRightRailIsOpen(false)
  }, [setRightRailIsOpen])

  const value = useMemo(
    () => ({
      side,
      setSide,
      toggleSide,
      rightRailIsOpen,
      toggleRightRailPane,
      openAIPanel,
      rightRailPanelRef,
      handleRightRailExpand,
      handleRightRailCollapse,
    }),
    [
      side,
      setSide,
      toggleSide,
      rightRailIsOpen,
      toggleRightRailPane,
      openAIPanel,
      handleRightRailExpand,
      handleRightRailCollapse,
    ]
  )

  if (!aiEnabled) {
    return <>{children}</>
  }

  return (
    <AIRailContext.Provider value={value}>{children}</AIRailContext.Provider>
  )
}

export function useAIRailContext(): AIRailContextType {
  const context = useContext(AIRailContext)
  if (!context) {
    throw new Error('useAIRailContext is only available inside AIRailProvider')
  }
  return context
}

/** Safe version that returns undefined when outside AIRailProvider (e.g. AI disabled) */
export function useOptionalAIRailContext() {
  return useContext(AIRailContext)
}
