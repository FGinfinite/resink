import { useCallback, useEffect } from 'react'
import { useCodeMirrorViewContext } from '@/features/source-editor/components/codemirror-context'
import { useProjectContext } from '@/shared/context/project-context'
import { useEditorOpenDocContext } from '@/features/ide-react/context/editor-open-doc-context'
import usePersistedState from '@/shared/hooks/use-persisted-state'
import getMeta from '@/utils/meta'
import { setAIAutocomplete } from '../extensions/ai-autocomplete'
import { useAutocompleteStatusUpdater } from '../context/autocomplete-status-context'

export default function AIAutocompleteBridge() {
  const view = useCodeMirrorViewContext()
  const { projectId } = useProjectContext()
  const { openDocName, currentDocumentId, currentDocument } =
    useEditorOpenDocContext()
  const [enabled] = usePersistedState<boolean>('ai-autocomplete-enabled', true)
  const { setStatus } = useAutocompleteStatusUpdater()

  const aiEnabled =
    getMeta('ol-capabilities')?.includes('ai-assistant') ?? false

  const onStatusChange = useCallback(
    (status: 'idle' | 'loading' | 'streaming', source?: 'auto' | 'enhanced') => {
      setStatus(status, source)
    },
    [setStatus]
  )

  // Wait until the document is fully loaded and the EditorState has been
  // rebuilt by useCodeMirrorScope (view.setState).  Without this guard the
  // Compartment reconfiguration from Batch 1 (openDocName change) would be
  // wiped out by view.setState in Batch 2 (currentDocument change), and the
  // effect would not re-run because openDocName didn't change in Batch 2.
  const docReady =
    !!currentDocument &&
    !!currentDocumentId &&
    (currentDocument.doc_id as string) === (currentDocumentId as string) &&
    !!openDocName

  useEffect(() => {
    if (!aiEnabled || !projectId || !docReady) {
      view.dispatch(
        setAIAutocomplete({
          enabled: false,
          projectId: '',
          fileName: '',
        })
      )
      setStatus('idle')
      return
    }

    const isEnabled = !!enabled

    view.dispatch(
      setAIAutocomplete({
        enabled: isEnabled,
        projectId,
        fileName: openDocName!,
        onStatusChange,
      })
    )

    // When disabling, ensure status resets to idle
    if (!isEnabled) {
      setStatus('idle')
    }

    // Cleanup on unmount: disable extension and reset status
    return () => {
      view.dispatch(
        setAIAutocomplete({
          enabled: false,
          projectId: '',
          fileName: '',
        })
      )
      setStatus('idle')
    }
  }, [
    view,
    enabled,
    aiEnabled,
    projectId,
    openDocName,
    currentDocumentId,
    currentDocument,
    onStatusChange,
    setStatus,
    docReady,
  ])

  return null // This component renders no DOM
}
