import logger from '@overleaf/logger'
import settings from '@overleaf/settings'
import { loadTemplate, injectVariables } from './prompt/system.js'
import { checkProjectWriteAccess, createRateLimiter } from './util/project-access.js'
import { getModelConfigService } from './ModelConfigService.js'

const PROJECT_ID_RE = /^[0-9a-fA-F]{24}$/

// Rate limiter: configurable requests per minute per user
const _checkRateLimit = createRateLimiter({ windowMs: settings.quickEdit?.rateLimitWindowMs || 60_000, max: settings.quickEdit?.rateLimitMax || 30 })

// Action-specific instruction mappings
const REWRITE_STYLES = {
  scientific:
    'Rewrite the text in a more formal, scientific academic style. Use precise terminology and passive voice where appropriate.',
  concise:
    'Rewrite the text to be more concise. Remove redundant words and phrases while preserving the original meaning.',
  punchy:
    'Rewrite the text to be more impactful and direct. Use strong verbs and clear statements.',
  split:
    'Split long sentences into shorter, clearer sentences. Each sentence should convey one main idea.',
  join: 'Combine short, choppy sentences into longer, flowing sentences where appropriate.',
}

// Allowed target languages with natural language names for prompts
const TARGET_LANGUAGES = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  de: 'German (Deutsch)',
  fr: 'French (Français)',
}

/**
 * Escape </data> closing tags in user-supplied text to prevent
 * premature termination of <data> blocks (prompt injection mitigation).
 * Also escapes opening <data tags to prevent injection of new data blocks.
 * Handles variants with optional internal whitespace (e.g. </data >, </data\t>).
 */
function escapeDataTags(text) {
  if (!text) return text
  // Match </data> with optional whitespace: </data>, </data >, </data\t>, etc.
  // Also match opening <data to prevent injection of new data blocks
  return text
    .replace(/<\/\s*data\s*>/gi, '<\\/data>')
    .replace(/<\s*data\b/gi, '<\\data')
}

const ACTION_INSTRUCTIONS = {
  rewrite: (style) => REWRITE_STYLES[style] || REWRITE_STYLES.scientific,
  translate: (_style, targetLanguage) => {
    const langName = TARGET_LANGUAGES[targetLanguage] || targetLanguage
    return `Translate the text into ${langName}. Preserve all LaTeX commands unchanged. Maintain the academic tone and meaning.`
  },
  paraphrase: () =>
    'Paraphrase the text to express the same ideas using different words and sentence structures. Maintain the same level of formality and technical precision.',
  deai: () =>
    'Remove AI writing traces from the text. Specifically:\n' +
    '1. Replace overused AI-characteristic words (e.g., "Furthermore", "Moreover", "Additionally", "It is worth noting that", "plays a crucial role", "leveraging", "delving into") with natural, varied alternatives or remove them.\n' +
    '2. Diversify sentence structure: break uniform same-length sentence patterns, mix short and long sentences.\n' +
    '3. Remove mechanical transition words at paragraph starts. Some paragraphs should start directly with the point.\n' +
    '4. Where natural, convert passive voice to active voice (e.g., "It was found that..." to "We found that...").\n' +
    '5. Keep all academic content, data, citations, and arguments completely intact. Only restyle the expression.\n' +
    '6. Preserve all LaTeX commands, environments, labels, and references exactly as they are.',
}

async function quickEdit(req, res) {
  const {
    projectId,
    selectedText,
    action,
    style,
    targetLanguage,
    surroundingContext,
    customInstruction,
  } = req.body
  const userId = req.headers['x-user-id'] || null

  // --- projectId and userId format validation ---
  if (!projectId || typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    return res.status(400).json({ error: 'projectId must be a valid 24-character hex string' })
  }
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  // --- Rate limiting (per-userId) ---
  if (!_checkRateLimit(userId)) {
    return res.status(429).json({ error: 'Too many requests' })
  }

  // --- Project write permission check ---
  if (!await checkProjectWriteAccess(projectId, userId)) {
    return res.status(403).json({ error: 'Write access denied' })
  }

  // Type validation
  if (selectedText != null && typeof selectedText !== 'string') {
    return res.status(400).json({ error: 'selectedText must be a string' })
  }
  if (surroundingContext != null && typeof surroundingContext !== 'string') {
    return res.status(400).json({ error: 'surroundingContext must be a string' })
  }
  if (customInstruction != null && typeof customInstruction !== 'string') {
    return res.status(400).json({ error: 'customInstruction must be a string' })
  }
  const maxCustomInstructionLen = settings.quickEdit?.maxCustomInstructionLength || 500
  if (customInstruction && customInstruction.length > maxCustomInstructionLen) {
    return res.status(400).json({
      error: `customInstruction must not exceed ${maxCustomInstructionLen} characters`
    })
  }

  // Validation
  if (!projectId || !selectedText || !action) {
    return res
      .status(400)
      .json({ error: 'projectId, selectedText, and action are required' })
  }

  if (!['rewrite', 'translate', 'paraphrase', 'deai'].includes(action)) {
    return res.status(400).json({
      error: 'action must be one of: rewrite, translate, paraphrase, deai',
    })
  }

  if (action === 'rewrite' && style && !REWRITE_STYLES[style]) {
    return res.status(400).json({
      error: `Invalid style. Must be one of: ${Object.keys(REWRITE_STYLES).join(', ')}`,
    })
  }

  if (action === 'translate' && !targetLanguage) {
    return res
      .status(400)
      .json({ error: 'targetLanguage is required for translate action' })
  }

  if (action === 'translate' && targetLanguage && !TARGET_LANGUAGES[targetLanguage]) {
    return res.status(400).json({
      error: `Invalid targetLanguage. Must be one of: ${Object.keys(TARGET_LANGUAGES).join(', ')}`,
    })
  }

  if (selectedText.length > (settings.quickEdit?.maxSelectionLength || 10000)) {
    return res
      .status(400)
      .json({ error: `selectedText must not exceed ${settings.quickEdit?.maxSelectionLength || 10000} characters` })
  }

  const abortController = new AbortController()
  const onClose = () => abortController.abort()
  req.once('close', onClose)

  try {
    // Build prompt
    const MAX_SURROUNDING_CONTEXT = settings.quickEdit?.maxSurroundingContext || 20000
    const surroundingCtx = typeof surroundingContext === 'string'
      ? surroundingContext.slice(0, MAX_SURROUNDING_CONTEXT)
      : ''

    let actionInstructions = ACTION_INSTRUCTIONS[action](
      style,
      targetLanguage
    )
    if (customInstruction && customInstruction.trim()) {
      actionInstructions += `\n\nAdditional editing instruction from the user: ${customInstruction.trim()}`
    }
    const template = await loadTemplate('quick-edit')
    const systemPrompt = injectVariables(template, {
      action_specific_instructions: actionInstructions,
    })

    // Build user message with selectedText and surroundingContext clearly
    // delimited as data to mitigate prompt injection risks.
    let userContent = ''
    if (surroundingCtx) {
      userContent += `<data label="surrounding_context">\n${escapeDataTags(surroundingCtx)}\n</data>\n\n`
    }
    userContent += `<data label="text_to_edit">\n${escapeDataTags(selectedText)}\n</data>\n\n`
    userContent += 'Please edit the text inside the "text_to_edit" block according to the instructions. Return ONLY the edited text.'

    // Call LLM (non-streaming)
    const maxTokens = Math.min(selectedText.length * 3, settings.quickEdit?.maxTokens || 4096)

    const modelConfigService = getModelConfigService()
    let adapter
    try {
      const resolved = await modelConfigService.resolveFeatureSlot('quickEdit')
      adapter = resolved.adapter
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to resolve quickEdit model')
      return res.status(503).json({ error: 'Quick Edit model not configured' })
    }

    const result = await adapter.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      maxTokens: Math.max(maxTokens, settings.quickEdit?.minTokens || 256),
      signal: abortController.signal,
    })

    req.removeListener('close', onClose)
    if (abortController.signal.aborted) return

    // Extract edited text, removing possible markdown code block wrapping
    const editedText = extractEditedText(result.content)

    logger.debug(
      { projectId, userId, action, style, targetLanguage },
      'quick-edit completed'
    )

    res.json({
      success: true,
      editedText,
      action,
      ...(style && { style }),
      ...(targetLanguage && { targetLanguage }),
    })
  } catch (error) {
    if (error?.name === 'AbortError' || abortController.signal.aborted) {
      logger.debug({ projectId, userId, action }, 'quick-edit aborted by client disconnect')
      return
    }
    logger.error(
      { err: error, projectId, userId, action },
      'quick-edit failed'
    )
    res.status(500).json({ error: 'Quick edit failed', code: 'QUICK_EDIT_ERROR' })
  }
}

/**
 * Remove markdown code block wrapping if present
 */
function extractEditedText(text) {
  if (!text) return ''
  let result = text.trim()
  // Remove ```...``` wrapping
  const codeBlockMatch = result.match(/^```(?:\w*)\n?([\s\S]*?)\n?```$/)
  if (codeBlockMatch) {
    result = codeBlockMatch[1].trim()
  }
  return result
}

export default { quickEdit }
