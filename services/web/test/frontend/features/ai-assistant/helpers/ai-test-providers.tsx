import React from 'react'
import { AIAssistantProvider } from '@/features/ai-assistant/context/ai-assistant-context'
import {
  EditorProviders,
  EditorProvidersProps,
} from '../../../helpers/editor-providers'

export interface AITestProvidersProps extends EditorProvidersProps {
  enableAI?: boolean
}

function AICapabilitiesSetup({
  children,
  enableAI,
}: {
  children: React.ReactNode
  enableAI: boolean
}) {
  // Override capabilities after EditorProviders sets them
  // This runs during render to ensure it happens before AIAssistantProvider checks
  if (enableAI) {
    const capabilities = window.metaAttributesCache.get('ol-capabilities') || []
    if (!capabilities.includes('ai-assistant')) {
      window.metaAttributesCache.set('ol-capabilities', [
        ...capabilities,
        'ai-assistant',
      ])
    }
  }
  window.metaAttributesCache.set('ol-csrfToken', 'test-csrf-token')
  window.metaAttributesCache.set('ol-preventCompileOnLoad', true)
  return <>{children}</>
}

function AITestProviders({
  children,
  enableAI = true,
  ...editorProps
}: AITestProvidersProps & { children: React.ReactNode }) {
  return (
    <EditorProviders {...editorProps}>
      <AICapabilitiesSetup enableAI={enableAI}>
        {enableAI ? (
          <AIAssistantProvider>{children}</AIAssistantProvider>
        ) : (
          <>{children}</>
        )}
      </AICapabilitiesSetup>
    </EditorProviders>
  )
}

export function createAIProviderWrapper(props: AITestProvidersProps = {}) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <AITestProviders {...props}>{children}</AITestProviders>
  }
}

export function setupAIMetaAttributes(
  options: {
    enableAI?: boolean
    csrfToken?: string
    projectId?: string
  } = {}
) {
  const {
    enableAI = true,
    csrfToken = 'test-csrf-token',
    projectId = 'project123',
  } = options

  const capabilities = ['chat', 'dropbox', 'link-sharing']
  if (enableAI) {
    capabilities.push('ai-assistant')
  }

  window.metaAttributesCache.set('ol-capabilities', capabilities)
  window.metaAttributesCache.set('ol-csrfToken', csrfToken)
  window.metaAttributesCache.set('ol-preventCompileOnLoad', true)
  window.metaAttributesCache.set('ol-project_id', projectId)
}

export function clearAIMetaAttributes() {
  window.metaAttributesCache.delete('ol-capabilities')
  window.metaAttributesCache.delete('ol-csrfToken')
  window.metaAttributesCache.delete('ol-preventCompileOnLoad')
}
