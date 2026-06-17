/**
 * Chat Input Component for AI Assistant
 * Uses Lexical editor with @ mention support, /slash commands, quote selection,
 * and image attachment via button, paste, or drag-and-drop
 */

import { memo, useCallback, useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  mergeRegister,
  type TextNode,
  type ElementNode,
} from 'lexical'
import { registerLexicalTextEntity } from '@lexical/text'
import MaterialIcon from '@/shared/components/material-icon'
import { MentionNode } from './chat-input/mention-node'
import { CommandTextNode, $createCommandNode, $isCommandNode } from './chat-input/command-node'
import { SKILL_NAME_SET, getSkillHint, getSkillByName } from './chat-input/skill-registry'
import MentionsPlugin from './chat-input/mentions-plugin'
import SlashCommandPlugin from './chat-input/slash-command-plugin'
import SubmitOnEnterPlugin, { extractContent } from './chat-input/submit-plugin'
import QuoteSelectionButton from './chat-input/quote-selection-button'
import ModelSelector from './chat-input/model-selector'
import type { Reference } from './chat-input/types'
import type { EntityMatch } from '@lexical/text'
import type { AttachmentInfo, ModelSlotInfo } from '../types/ai-types'
import {
  ACCEPTED_IMAGE_TYPES,
  ACCEPTED_ATTACHMENT_TYPES,
  ACCEPTED_TEXT_TYPES,
  MAX_IMAGE_SIZE,
  uploadFile,
} from '../api/ai-api'

interface ChatInputProps {
  onSendMessage: (content: string, references?: Reference[], skill?: string, pendingAttachments?: AttachmentInfo[]) => void
  onStopConversation: () => void
  isStreaming: boolean
  projectId: string
  selectedModelSlot: string | null
  onModelSlotChange: (slug: string) => void
  availableModelSlots: ModelSlotInfo[]
  currentModelSupportsImage: boolean
}

const EDITOR_THEME = {
  text: {
    base: '',
  },
}

function onError(_error: Error) {
  // Lexical internal errors are non-recoverable; no-op handler
}

// ---------------------------------------------------------------------------
// Entity match for CommandTextNode (registerLexicalTextEntity)
// ---------------------------------------------------------------------------

function getCommandMatch(text: string): EntityMatch | null {
  const match = text.match(/^(\/[\w-]+)/)
  if (!match) return null
  const commandName = match[1].slice(1) // strip leading /
  if (!SKILL_NAME_SET.has(commandName)) return null
  // P2: Only convert to CommandTextNode if this text is at the very start
  // of the editor. Prevents false matches in later paragraphs or after
  // @mention nodes.
  const fullText = $getRoot().getTextContent()
  if (!fullText.startsWith(match[1])) return null
  return { start: 0, end: match[1].length }
}

/**
 * Registers automatic TextNode <-> CommandTextNode conversion via
 * @lexical/text's registerLexicalTextEntity.
 */
function CommandEntityPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return mergeRegister(
      ...registerLexicalTextEntity(
        editor,
        getCommandMatch,
        CommandTextNode,
        (textNode: TextNode) => $createCommandNode(textNode.getTextContent())
      )
    )
  }, [editor])

  return null
}

// ---------------------------------------------------------------------------
// SkillInsertPlugin – replaces old SkillSubmitPlugin
// ---------------------------------------------------------------------------

/**
 * Listens for 'ai-skill-insert' custom DOM events from skill toolbar buttons.
 * Instead of immediately sending, inserts /skillName into the editor so the
 * user can add references and free text before pressing Enter.
 */
function SkillInsertPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    const handler = (e: Event) => {
      const { skillName } = (e as CustomEvent).detail as { skillName: string }
      if (!SKILL_NAME_SET.has(skillName)) return

      editor.update(() => {
        const root = $getRoot()
        let firstParagraph = root.getFirstChild<ElementNode>()
        if (!firstParagraph) {
          firstParagraph = $createParagraphNode()
          root.append(firstParagraph)
        }

        // P1: Remove any existing CommandTextNode (and its trailing space)
        // before inserting the new one, to prevent duplicates.
        const existingCmd = firstParagraph.getFirstChild()
        if (existingCmd && $isCommandNode(existingCmd)) {
          const next = existingCmd.getNextSibling()
          existingCmd.remove()
          // Remove the trailing space that was inserted with the old command
          if (next && next.getTextContent() === ' ') {
            next.remove()
          }
        }

        const commandNode = $createCommandNode(`/${skillName}`)
        const spaceNode = $createTextNode(' ')
        const editorText = root.getTextContent().trim()

        if (editorText === '') {
          // Editor is empty – insert command + space
          firstParagraph.clear()
          firstParagraph.append(commandNode, spaceNode)
        } else {
          // Editor has content – prepend command at the very beginning
          const firstChild = firstParagraph.getFirstChild()
          if (firstChild) {
            firstChild.insertBefore(spaceNode)
            spaceNode.insertBefore(commandNode)
          } else {
            firstParagraph.append(commandNode, spaceNode)
          }
        }

        // Move cursor to end of editor so user can continue typing
        const lastParagraph = root.getLastChild<ElementNode>()
        if (lastParagraph) {
          const lastChild = lastParagraph.getLastChild()
          if (lastChild) {
            lastChild.selectEnd()
          } else {
            lastParagraph.selectEnd()
          }
        }
      })

      // Focus the editor
      editor.focus()
    }

    document.addEventListener('ai-skill-insert', handler)
    return () => document.removeEventListener('ai-skill-insert', handler)
  }, [editor])

  return null
}

// ---------------------------------------------------------------------------
// DynamicPlaceholderPlugin
// ---------------------------------------------------------------------------

/**
 * Shows context-sensitive placeholder text:
 * - Empty editor: general guidance
 * - /command only: skill-specific hint (offset after the command text)
 */
function DynamicPlaceholderPlugin(): React.ReactElement | null {
  const [editor] = useLexicalComposerContext()
  const { t } = useTranslation()
  const defaultPlaceholder = t(
    'ai_message_placeholder_hint',
    '输入消息，/ 选择技能，@ 引用文件'
  )

  const [state, setState] = useState<{
    show: boolean
    text: string
    offset: number
  }>({ show: true, text: defaultPlaceholder, offset: 0 })

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const text = $getRoot().getTextContent()

        if (text.trim() === '') {
          setState({ show: true, text: defaultPlaceholder, offset: 0 })
          return
        }

        // Detect "/command" or "/command " with nothing else
        const match = text.match(/^\/([\w-]+)\s*$/)
        if (match && SKILL_NAME_SET.has(match[1])) {
          const hint = getSkillHint(match[1])
          if (hint) {
            setState({ show: true, text: hint, offset: text.length })
            return
          }
        }

        setState({ show: false, text: '', offset: 0 })
      })
    })
  }, [editor, defaultPlaceholder])

  if (!state.show) return null

  return (
    <div
      className="ai-chat-input-placeholder"
      style={state.offset > 0 ? { paddingLeft: `${state.offset}ch` } : undefined}
    >
      {state.text}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Attachment Helpers
// ---------------------------------------------------------------------------

function isValidAttachmentFile(file: File): { valid: boolean; error?: string } {
  if (!ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
    return { valid: false, error: `Unsupported file type: ${file.type}` }
  }
  if (file.size > MAX_IMAGE_SIZE) {
    return { valid: false, error: `File too large (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)` }
  }
  return { valid: true }
}

function isImageMime(mimeType: string): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(mimeType)
}

function extractAttachmentFiles(dataTransfer: DataTransfer): File[] {
  const files: File[] = []
  for (let i = 0; i < dataTransfer.files.length; i++) {
    const file = dataTransfer.files[i]
    if (ACCEPTED_ATTACHMENT_TYPES.includes(file.type)) {
      files.push(file)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// ChatInput
// ---------------------------------------------------------------------------

function ChatInput({ onSendMessage, onStopConversation, isStreaming, projectId, selectedModelSlot, onModelSlotChange, availableModelSlots, currentModelSupportsImage }: ChatInputProps) {
  const { t } = useTranslation()

  // Attachment state
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentInfo[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Track preview URLs for cleanup
  const previewUrlsRef = useRef<Set<string>>(new Set())

  // Cleanup local preview URLs on unmount
  useEffect(() => {
    return () => {
      previewUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    }
  }, [])

  const addFiles = useCallback((files: File[]) => {
    setAttachmentError(null)
    for (const file of files) {
      const check = isValidAttachmentFile(file)
      if (!check.valid) {
        setAttachmentError(check.error || 'Invalid file')
        continue
      }
      const localPreviewUrl = isImageMime(file.type) ? URL.createObjectURL(file) : undefined
      if (localPreviewUrl) {
        previewUrlsRef.current.add(localPreviewUrl)
      }

      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const tempAttachment: AttachmentInfo = {
        id: tempId,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
        localPreviewUrl,
        uploadStatus: 'uploading',
      }
      setPendingAttachments(prev => [...prev, tempAttachment])

      // Immediately upload the file
      uploadFile(file)
        .then(result => {
          setPendingAttachments(prev =>
            prev.map(att =>
              att.id === tempId
                ? { ...att, id: result.id, uploadStatus: 'uploaded' as const }
                : att
            )
          )
        })
        .catch(err => {
          setPendingAttachments(prev =>
            prev.map(att =>
              att.id === tempId
                ? { ...att, uploadStatus: 'error' as const, uploadError: err.message }
                : att
            )
          )
        })
    }
  }, [])

  const removeAttachment = useCallback((attachmentId: string) => {
    // Find the attachment to revoke its blob URL before updating state.
    // Reading pendingAttachments from the functional updater's prev is fine
    // for filtering, but side effects should happen outside the updater.
    setPendingAttachments(prev => {
      const removed = prev.find(a => a.id === attachmentId)
      if (removed?.localPreviewUrl) {
        // Schedule revocation after the state update (microtask) to avoid
        // side effects inside the pure updater function.
        queueMicrotask(() => {
          URL.revokeObjectURL(removed.localPreviewUrl!)
          previewUrlsRef.current.delete(removed.localPreviewUrl!)
        })
      }
      return prev.filter(a => a.id !== attachmentId)
    })
  }, [])

  // File input handler
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) addFiles(files)
    // Reset input so same file can be re-selected
    e.target.value = ''
  }, [addFiles])

  // Paste handler
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = extractAttachmentFiles(e.clipboardData)
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  // Drag handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const files = extractAttachmentFiles(e.dataTransfer)
    if (files.length > 0) addFiles(files)
  }, [addFiles])

  const initialConfig = {
    namespace: 'AIChatInput',
    theme: EDITOR_THEME,
    nodes: [MentionNode, CommandTextNode],
    onError,
  }

  const handleSubmit = useCallback(
    async (text: string, references: Reference[], skill?: string) => {
      const uploadedFiles = pendingAttachments.filter(att => att.uploadStatus === 'uploaded')
      if (!text.trim() && !skill && uploadedFiles.length === 0) return
      if (isStreaming) return

      // Block send while any file is still uploading
      if (pendingAttachments.some(att => att.uploadStatus === 'uploading')) return

      const toSend = uploadedFiles.length > 0 ? [...uploadedFiles] : undefined

      // Revoke blob URLs for sent attachments before clearing state.
      // Message-list will use the server URL instead of localPreviewUrl.
      for (const att of pendingAttachments) {
        if (att.localPreviewUrl) {
          URL.revokeObjectURL(att.localPreviewUrl)
          previewUrlsRef.current.delete(att.localPreviewUrl)
        }
      }
      setPendingAttachments([])

      onSendMessage(
        text.trim(),
        references.length > 0 ? references : undefined,
        skill,
        toSend
      )
    },
    [isStreaming, onSendMessage, pendingAttachments]
  )

  const handleSendClick = useCallback(() => {
    // Trigger submit via a synthetic Enter key on the Lexical editor
    const editable = document.querySelector<HTMLDivElement>('.ai-chat-input-editable')
    if (editable) {
      editable.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      )
    }
  }, [])

  return (
    <div
      className={`ai-chat-input${isDragOver ? ' ai-chat-input-dragover' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <LexicalComposer initialConfig={initialConfig}>
        <div className="ai-chat-input-wrapper" onPaste={handlePaste}>
          <div className="ai-chat-input-editor">
            <PlainTextPlugin
              contentEditable={
                <ContentEditable
                  className="ai-chat-input-editable"
                  aria-label={t('ai_message_placeholder', 'Ask AI Assistant...')}
                />
              }
              placeholder={null}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <DynamicPlaceholderPlugin />
          </div>
          <QuoteSelectionButton />
          <ModelSelector
            selectedSlot={selectedModelSlot}
            onSlotChange={onModelSlotChange}
            availableSlots={availableModelSlots}
            disabled={isStreaming}
          />
          {/* Attachment button */}
          <button
            type="button"
            className="ai-chat-attach-button"
            onClick={() => fileInputRef.current?.click()}
            aria-label={t('attach_file', 'Attach file')}
          >
            <MaterialIcon type="attach_file" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={currentModelSupportsImage ? ACCEPTED_ATTACHMENT_TYPES.join(',') : ACCEPTED_TEXT_TYPES.join(',')}
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          {isStreaming ? (
            <button
              type="button"
              className="ai-chat-stop-button"
              onClick={onStopConversation}
              aria-label={t('stop_conversation', 'Stop')}
            >
              <MaterialIcon type="stop_circle" />
            </button>
          ) : (
            <button
              type="button"
              className="ai-chat-send-button"
              onClick={handleSendClick}
              disabled={false}
              aria-label={t('send_message', 'Send message')}
            >
              <MaterialIcon type="send" />
            </button>
          )}
        </div>

        {/* Attachment error */}
        {attachmentError && (
          <div className="ai-chat-attach-error">
            <MaterialIcon type="error_outline" />
            <span>{attachmentError}</span>
            <button
              type="button"
              className="ai-chat-attach-error-dismiss"
              onClick={() => setAttachmentError(null)}
            >
              <MaterialIcon type="close" />
            </button>
          </div>
        )}

        {/* Attachment previews */}
        {pendingAttachments.length > 0 && (
          <div className="ai-chat-attach-previews">
            {pendingAttachments.map(att => (
              <div key={att.id} className="ai-chat-attach-preview">
                {att.localPreviewUrl ? (
                  <img
                    src={att.localPreviewUrl}
                    alt={att.filename}
                    className="ai-chat-attach-thumb"
                  />
                ) : (
                  <div className="ai-chat-attach-file-icon">
                    <MaterialIcon type="description" />
                    <span className="ai-chat-attach-file-name" title={att.filename}>
                      {att.filename}
                    </span>
                  </div>
                )}
                {att.uploadStatus === 'uploading' && (
                  <div className="ai-chat-attach-uploading">
                    <MaterialIcon type="hourglass_empty" />
                  </div>
                )}
                {att.uploadStatus === 'error' && (
                  <div className="ai-chat-attach-error-badge" title={att.uploadError}>
                    <MaterialIcon type="error" />
                  </div>
                )}
                <button
                  type="button"
                  className="ai-chat-attach-remove"
                  onClick={() => removeAttachment(att.id)}
                  aria-label={t('remove_attachment', 'Remove')}
                >
                  <MaterialIcon type="close" />
                </button>
              </div>
            ))}
          </div>
        )}

        <HistoryPlugin />
        <MentionsPlugin projectId={projectId} />
        <SlashCommandPlugin />
        <SubmitOnEnterPlugin onSubmit={handleSubmit} isStreaming={isStreaming} allowEmptySubmit={pendingAttachments.some(att => att.uploadStatus === 'uploaded')} />
        <SkillInsertPlugin />
        <CommandEntityPlugin />
      </LexicalComposer>
    </div>
  )
}

export default memo(ChatInput)
