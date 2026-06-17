/**
 * Mock AI Service for E2E Testing
 *
 * This service simulates the AI Assistant backend for testing purposes.
 * It provides endpoints that mirror the real AI service API.
 */

const express = require('express')
const { v4: uuid } = require('uuid')

const app = express()
app.use(express.json())

// Store sessions in memory
const sessions = new Map()

// Health check
app.get('/api/ai/health', (req, res) => {
  res.status(200).json({ status: 'ok' })
})

// Create session
app.post('/api/ai/sessions', (req, res) => {
  const { projectId, docId } = req.body
  const session = {
    id: `session-${uuid()}`,
    projectId: projectId || 'unknown',
    docId: docId || null,
    status: 'idle',
    messages: [],
    pendingChanges: [],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  sessions.set(session.id, session)
  res.status(200).json({ session })
})

// Get session
app.get('/api/ai/sessions/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) {
    return res.status(404).json({ message: 'Session not found' })
  }
  res.status(200).json({ session })
})

// Delete session
app.delete('/api/ai/sessions/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId)
  res.status(204).send()
})

// Send message (SSE streaming)
app.post('/api/ai/sessions/:sessionId/messages', (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) {
    return res.status(404).json({ message: 'Session not found' })
  }

  const { content, docId } = req.body

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const messageId = `msg-${uuid()}`

  // Generate mock response based on user input
  const responseText = generateMockResponse(content)

  // Stream the response in chunks
  const chunks = splitIntoChunks(responseText, 10)

  let chunkIndex = 0
  const interval = setInterval(() => {
    if (chunkIndex < chunks.length) {
      const event = {
        type: 'text_chunk',
        content: chunks[chunkIndex],
        messageId,
        timestamp: Date.now(),
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      chunkIndex++
    } else {
      // Send message complete event
      const completeEvent = {
        type: 'message_complete',
        message: {
          id: messageId,
          role: 'assistant',
          content: responseText,
          timestamp: Date.now(),
        },
        timestamp: Date.now(),
      }
      res.write(`data: ${JSON.stringify(completeEvent)}\n\n`)

      // Send done marker
      res.write('data: [DONE]\n\n')
      clearInterval(interval)
      res.end()
    }
  }, 50)

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(interval)
  })
})

// Accept change
app.post('/api/ai/sessions/:sessionId/changes/:changeId/accept', (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) {
    return res.status(404).json({ message: 'Session not found' })
  }

  const change = {
    id: req.params.changeId,
    status: 'accepted',
    acceptedAt: Date.now(),
  }

  res.status(200).json({ success: true, change })
})

// Reject change
app.post('/api/ai/sessions/:sessionId/changes/:changeId/reject', (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) {
    return res.status(404).json({ message: 'Session not found' })
  }

  const change = {
    id: req.params.changeId,
    status: 'rejected',
    rejectedAt: Date.now(),
  }

  res.status(200).json({ success: true, change })
})

// Accept all changes
app.post('/api/ai/sessions/:sessionId/changes/accept-all', (req, res) => {
  res.status(200).json({ success: true, changes: [] })
})

// Reject all changes
app.post('/api/ai/sessions/:sessionId/changes/reject-all', (req, res) => {
  res.status(200).json({ success: true, changes: [] })
})

// Helper functions
function generateMockResponse(userMessage) {
  const lowerMessage = (userMessage || '').toLowerCase()

  if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
    return "Hello! I'm your AI writing assistant. I can help you with LaTeX documents, suggest improvements, and answer questions about your paper. How can I assist you today?"
  }

  if (lowerMessage.includes('help')) {
    return 'I can help you with:\n- Writing and editing LaTeX content\n- Fixing compilation errors\n- Improving document structure\n- Adding citations and references\n- Explaining LaTeX commands\n\nJust ask me anything about your document!'
  }

  if (lowerMessage.includes('latex') || lowerMessage.includes('equation')) {
    return 'For mathematical equations in LaTeX, you can use:\n- Inline math: $E = mc^2$\n- Display math: \\begin{equation}\n  f(x) = \\int_{-\\infty}^{\\infty} e^{-x^2} dx\n\\end{equation}\n\nWould you like me to help you write a specific equation?'
  }

  if (lowerMessage.includes('fix') || lowerMessage.includes('error')) {
    return "I'd be happy to help fix any issues. Could you please share the specific error message or describe what's not working? I can then provide targeted suggestions to resolve the problem."
  }

  // Default response
  return `I understand you're asking about: "${userMessage}". As your AI assistant, I'm here to help with your LaTeX document. Could you provide more details about what you'd like to accomplish?`
}

function splitIntoChunks(text, chunkSize) {
  const chunks = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

// Start server
const PORT = process.env.PORT || 3060
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mock AI Service running on port ${PORT}`)
})
