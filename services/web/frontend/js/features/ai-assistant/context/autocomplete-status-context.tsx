import {
  type PropsWithChildren,
  createContext,
  useContext,
  useMemo,
  useState,
  FC,
} from 'react'

type AutocompleteStatus = 'idle' | 'loading' | 'streaming'
type AutocompleteSource = 'auto' | 'enhanced'

type AutocompleteStatusContextType = {
  status: AutocompleteStatus
  source: AutocompleteSource
}

type AutocompleteStatusUpdaterContextType = {
  setStatus: (status: AutocompleteStatus, source?: AutocompleteSource) => void
}

const AutocompleteStatusContext = createContext<
  AutocompleteStatusContextType | undefined
>(undefined)
const AutocompleteStatusUpdaterContext = createContext<
  AutocompleteStatusUpdaterContextType | undefined
>(undefined)

export const AutocompleteStatusProvider: FC<PropsWithChildren> = ({
  children,
}) => {
  const [status, setStatusRaw] = useState<AutocompleteStatus>('idle')
  const [source, setSourceRaw] = useState<AutocompleteSource>('auto')

  const statusCtx = useMemo(() => ({ status, source }), [status, source])

  const updaterCtx = useMemo(
    () => ({
      setStatus: (newStatus: AutocompleteStatus, newSource?: AutocompleteSource) => {
        setStatusRaw(newStatus)
        if (newSource !== undefined) {
          setSourceRaw(newSource)
        } else if (newStatus === 'idle') {
          setSourceRaw('auto')
        }
      },
    }),
    []
  )

  return (
    <AutocompleteStatusContext.Provider value={statusCtx}>
      <AutocompleteStatusUpdaterContext.Provider value={updaterCtx}>
        {children}
      </AutocompleteStatusUpdaterContext.Provider>
    </AutocompleteStatusContext.Provider>
  )
}

export function useAutocompleteStatus(): AutocompleteStatusContextType {
  const context = useContext(AutocompleteStatusContext)
  if (!context) {
    throw new Error(
      'useAutocompleteStatus is only available inside AutocompleteStatusProvider'
    )
  }
  return context
}

export function useAutocompleteStatusUpdater(): AutocompleteStatusUpdaterContextType {
  const context = useContext(AutocompleteStatusUpdaterContext)
  if (!context) {
    throw new Error(
      'useAutocompleteStatusUpdater is only available inside AutocompleteStatusProvider'
    )
  }
  return context
}
