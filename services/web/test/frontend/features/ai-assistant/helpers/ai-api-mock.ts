import fetchMock from 'fetch-mock'
import type { AIEvent } from '@/features/ai-assistant/types/ai-types'

export function mockSSEResponse(events: AIEvent[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        const data = `data: ${JSON.stringify(event)}\n\n`
        controller.enqueue(encoder.encode(data))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

export function mockDelayedSSEResponse(
  events: AIEvent[],
  delayMs: number = 10
): Response {
  const encoder = new TextEncoder()
  let index = 0

  const stream = new ReadableStream({
    async pull(controller) {
      if (index < events.length) {
        await new Promise(resolve => setTimeout(resolve, delayMs))
        const data = `data: ${JSON.stringify(events[index])}\n\n`
        controller.enqueue(encoder.encode(data))
        index++
      } else {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

export function resetAIApiMocks() {
  fetchMock.removeRoutes().clearHistory()
  fetchMock.get(/\/api\/ai\/model-slots\/default$/, {
    status: 200,
    body: { defaultSlot: 'basic' },
  })
  fetchMock.get(/\/api\/ai\/model-slots$/, {
    status: 200,
    body: {
      slots: [
        {
          slug: 'basic',
          label: 'Basic',
          description: 'Default test slot',
        },
      ],
    },
  })
}
