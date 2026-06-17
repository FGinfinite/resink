import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'

const MAX_PREFIX_CHARS = 2000
const MAX_SUFFIX_CHARS = 500
const ENHANCED_MAX_PREFIX_CHARS = 8000
const ENHANCED_MAX_SUFFIX_CHARS = 2000
const STREAM_TIMEOUT_MS = 30_000
const MAX_SSE_BUFFER_CHARS = 1024 * 1024 // 1MB

export interface AutocompleteRequest {
  projectId: string
  prefix: string
  suffix: string
  fileName?: string
  cursorLine?: number
  documentCharCount?: number
  recentEdits?: Array<{ text: string; line: number }>
  mode?: 'auto' | 'enhanced'
  selectedContext?: string
}

export interface AutocompleteResponse {
  completion: string
}

const getAIBaseUrl = (): string => '/api/ai'

export async function fetchCompletion(
  request: AutocompleteRequest,
  signal?: AbortSignal
): Promise<AutocompleteResponse> {
  const baseUrl = getAIBaseUrl()
  // Truncate on the client side to reduce payload size
  const maxPrefix = request.mode === 'enhanced' ? ENHANCED_MAX_PREFIX_CHARS : MAX_PREFIX_CHARS
  const maxSuffix = request.mode === 'enhanced' ? ENHANCED_MAX_SUFFIX_CHARS : MAX_SUFFIX_CHARS
  const truncatedRequest = {
    ...request,
    prefix: request.prefix.slice(-maxPrefix),
    suffix: request.suffix.slice(0, maxSuffix),
  }
  return postJSON<AutocompleteResponse>(`${baseUrl}/autocomplete`, {
    body: truncatedRequest,
    signal,
  })
}

export interface AutocompleteStreamEvent {
  type: 'text' | 'done' | 'error'
  content?: string
  completion?: string
  message?: string
}

export async function* fetchCompletionStream(
  request: AutocompleteRequest,
  signal?: AbortSignal
): AsyncGenerator<AutocompleteStreamEvent, void, unknown> {
  const baseUrl = getAIBaseUrl()
  const csrfToken = getMeta('ol-csrfToken')

  const maxPrefix = request.mode === 'enhanced' ? ENHANCED_MAX_PREFIX_CHARS : MAX_PREFIX_CHARS
  const maxSuffix = request.mode === 'enhanced' ? ENHANCED_MAX_SUFFIX_CHARS : MAX_SUFFIX_CHARS
  const truncatedRequest = {
    ...request,
    prefix: request.prefix.slice(-maxPrefix),
    suffix: request.suffix.slice(0, maxSuffix),
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS)
  const onExternalAbort = () => controller.abort()
  signal?.addEventListener('abort', onExternalAbort, { once: true })

  const response = await fetch(`${baseUrl}/autocomplete/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-Csrf-Token': csrfToken } : {}),
      Accept: 'text/event-stream',
    },
    credentials: 'same-origin',
    body: JSON.stringify(truncatedRequest),
    signal: controller.signal,
  })

  if (!response.ok) {
    yield { type: 'error', message: `HTTP ${response.status}` }
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    yield { type: 'error', message: 'No response body' }
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        await reader.cancel()
        yield { type: 'error', message: 'SSE buffer exceeded maximum size' }
        return
      }

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') return
          try {
            const event = JSON.parse(data) as AutocompleteStreamEvent
            yield event
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', onExternalAbort)
    await reader.cancel()
    reader.releaseLock()
  }
}
