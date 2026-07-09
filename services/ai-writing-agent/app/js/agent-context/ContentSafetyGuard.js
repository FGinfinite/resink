import { validationError } from './AgentContextErrors.js'

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|secret|password|token|credential)\s*[:=]\s*\S+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
]

const PROMPT_INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
  /\breveal\s+(?:the\s+)?(?:system|hidden|developer)\s+prompt\b/i,
  /\bshow\s+(?:me\s+)?(?:the\s+)?(?:system|hidden|developer)\s+prompt\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?developer\s+mode\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
]

export function assertAgentContextContentSafe(content, label = 'content') {
  const text = String(content ?? '')
  const reason = detectUnsafeAgentContextContent(text)
  if (!reason) return text
  throw validationError(
    `${label} contains ${reason} and cannot be saved to Agent Context`,
    'AGENT_CONTEXT_CONTENT_BLOCKED'
  )
}

export function detectUnsafeAgentContextContent(content) {
  const text = String(content ?? '')
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    return 'secret-looking content'
  }
  if (PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(text))) {
    return 'prompt-injection-looking content'
  }
  return null
}
