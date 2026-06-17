import type { LogEntry } from '@/features/pdf-preview/util/types'

export type CompileErrorPayload =
  | { mode: 'batch'; entries: LogEntry[]; rawLogExcerpt?: string }
  | { mode: 'single'; entry: LogEntry }

// Module-level queue + callback pattern
// Handles both cases:
//   1. AI panel already mounted: callback fires directly
//   2. AI panel not yet mounted: payload queued, delivered on registration
let pendingPayload: CompileErrorPayload | null = null
let onEnqueueCallback: ((payload: CompileErrorPayload) => void) | null = null

export function enqueueCompileErrors(payload: CompileErrorPayload) {
  if (onEnqueueCallback) {
    onEnqueueCallback(payload)
  } else {
    pendingPayload = payload
  }
}

/** Register a handler. If there's a pending payload, delivers it immediately. */
export function registerCompileErrorHandler(
  handler: (payload: CompileErrorPayload) => void
) {
  onEnqueueCallback = handler
  if (pendingPayload) {
    const payload = pendingPayload
    pendingPayload = null
    handler(payload)
  }
}

export function unregisterCompileErrorHandler() {
  onEnqueueCallback = null
}

/**
 * Select top entries by priority: errors → warnings → typesetting,
 * capped at `limit`.
 */
export function selectTopEntries(
  logEntries: {
    errors: LogEntry[]
    warnings: LogEntry[]
    typesetting: LogEntry[]
  },
  limit = 10
): LogEntry[] {
  const result: LogEntry[] = []
  for (const entry of logEntries.errors) {
    if (result.length >= limit) break
    result.push(entry)
  }
  for (const entry of logEntries.warnings) {
    if (result.length >= limit) break
    result.push(entry)
  }
  for (const entry of logEntries.typesetting) {
    if (result.length >= limit) break
    result.push(entry)
  }
  return result
}

/** Format a single log entry for AI consumption */
export function formatSingleEntryForAI(entry: LogEntry): string {
  const parts: string[] = []
  if (entry.level) parts.push(`[${entry.level}]`)
  if (entry.file) parts.push(`File: ${entry.file}`)
  if (entry.line) parts.push(`Line: ${entry.line}`)
  if (entry.message) parts.push(`${entry.message}`)
  if (entry.content) parts.push(`Details: ${entry.content}`)
  return parts.join(' | ')
}

/** Serialize multiple entries into AI-readable text, each prefixed with [level] */
export function formatCompileErrorsForAI(entries: LogEntry[]): string {
  return entries
    .map((err, i) => {
      const parts: string[] = []
      if (err.level) parts.push(`[${err.level}]`)
      if (err.file) parts.push(`File: ${err.file}`)
      if (err.line) parts.push(`Line: ${err.line}`)
      if (err.message) parts.push(`${err.message}`)
      if (err.content) parts.push(`Details: ${err.content}`)
      return `${i + 1}. ${parts.join(' | ')}`
    })
    .join('\n')
}
