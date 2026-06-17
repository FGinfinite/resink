import {
  createContext,
  useContext,
  useMemo,
  useState,
  FC,
} from 'react'
import type { StreamingPhase } from '../types/ai-types'

type AIStatusValue = {
  status: 'idle' | 'pending' | 'streaming' | 'error'
  streamingPhase: StreamingPhase | null
}

type AIStatusContextType = {
  status: AIStatusValue['status']
  streamingPhase: AIStatusValue['streamingPhase']
}

type AIStatusUpdaterContextType = {
  setStatus: (value: AIStatusValue) => void
}

const AIStatusContext = createContext<AIStatusContextType | undefined>(undefined)
const AIStatusUpdaterContext = createContext<
  AIStatusUpdaterContextType | undefined
>(undefined)

export const AIStatusProvider: FC<React.PropsWithChildren> = ({ children }) => {
  const [value, setValue] = useState<AIStatusValue>({
    status: 'idle',
    streamingPhase: null,
  })

  const statusCtx = useMemo(
    () => ({
      status: value.status,
      streamingPhase: value.streamingPhase,
    }),
    [value.status, value.streamingPhase]
  )

  const updaterCtx = useMemo(
    () => ({
      setStatus: setValue,
    }),
    []
  )

  return (
    <AIStatusContext.Provider value={statusCtx}>
      <AIStatusUpdaterContext.Provider value={updaterCtx}>
        {children}
      </AIStatusUpdaterContext.Provider>
    </AIStatusContext.Provider>
  )
}

export function useAIStatus(): AIStatusContextType {
  const context = useContext(AIStatusContext)
  if (!context) {
    throw new Error('useAIStatus is only available inside AIStatusProvider')
  }
  return context
}

export function useAIStatusUpdater(): AIStatusUpdaterContextType {
  const context = useContext(AIStatusUpdaterContext)
  if (!context) {
    throw new Error(
      'useAIStatusUpdater is only available inside AIStatusProvider'
    )
  }
  return context
}

/** Safe hook for components outside AIStatusProvider tree — returns null instead of throwing */
export function useOptionalAIStatus(): AIStatusContextType | null {
  return useContext(AIStatusContext) ?? null
}
