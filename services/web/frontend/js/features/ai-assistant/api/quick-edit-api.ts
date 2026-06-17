import { postJSON } from '@/infrastructure/fetch-json'
import type { QuickEditRequest, QuickEditResponse } from '../types/ai-types'

const getAIBaseUrl = (): string => '/api/ai'

export async function quickEdit(request: QuickEditRequest): Promise<QuickEditResponse> {
  const baseUrl = getAIBaseUrl()
  return postJSON<QuickEditResponse>(`${baseUrl}/quick-edit`, {
    body: { ...request },
  })
}
