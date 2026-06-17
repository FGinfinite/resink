export interface QuoteToAIPayload {
  selectedText: string
  filePath: string
  startLine: number
  endLine: number
  docId: string
}

type Listener = (payload: QuoteToAIPayload) => void

class QuoteToAIBridge {
  private listeners: Set<Listener> = new Set()

  emit(payload: QuoteToAIPayload): void {
    this.listeners.forEach(listener => listener(payload))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const quoteToAIBridge = new QuoteToAIBridge()
