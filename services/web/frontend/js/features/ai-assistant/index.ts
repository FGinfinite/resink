/**
 * AI Assistant Feature - Main Export
 */

// Components
export { default as AIAssistantPane } from './components/ai-assistant-pane'
export { AIAssistantIndicator } from './components/ai-assistant-pane'
export { default as AIAssistantFallbackError } from './components/ai-assistant-fallback-error'

// Context
export {
  AIAssistantContext,
  AIAssistantProvider,
  useAIAssistantContext,
} from './context/ai-assistant-context'

export {
  AIStatusProvider,
  useAIStatus,
  useAIStatusUpdater,
} from './context/ai-status-context'

export {
  AIRailProvider,
  useAIRailContext,
  useOptionalAIRailContext,
} from './context/ai-rail-context'
export type { AIPanelSide } from './context/ai-rail-context'

export {
  AutocompleteStatusProvider,
  useAutocompleteStatus,
  useAutocompleteStatusUpdater,
} from './context/autocomplete-status-context'

// Hooks
export {
  useAISession,
  useAIChat,
  useAwaitingConfirmation,
} from './hooks/use-ai-hooks'

// API
export * as aiApi from './api/ai-api'

// Types
export type {
  AIMessage,
  AISession,
  PendingChange,
  AIEvent,
  ChangeStatus,
  SessionStatus,
  ContentBlock,
  SessionSummary,
} from './types/ai-types'
