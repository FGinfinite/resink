import { useEffect } from 'react'
import {
  KEY_ENTER_COMMAND,
  COMMAND_PRIORITY_HIGH,
  $getRoot,
  $createParagraphNode,
  $isElementNode,
  type LexicalNode,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $isMentionNode } from './mention-node'
import { $isCommandNode } from './command-node'
import type { Reference } from './types'

interface SubmitOnEnterPluginProps {
  onSubmit: (text: string, references: Reference[], skill?: string) => void
  isStreaming: boolean
  allowEmptySubmit?: boolean
}

export function extractContent(): { text: string; references: Reference[]; skill?: string } {
  const root = $getRoot()
  const references: Reference[] = []
  let skill: string | undefined

  // Walk the tree to find MentionNodes and CommandTextNodes.
  root.getChildren().forEach((paragraph: LexicalNode) => {
    if (!$isElementNode(paragraph)) return
    paragraph.getChildren().forEach((child: LexicalNode) => {
      if ($isMentionNode(child)) {
        references.push({
          type: child.__mentionType,
          path: child.__filePath,
          startLine: child.__startLine,
          endLine: child.__endLine,
          selectionText: child.__selectionText,
        })
      }
      if ($isCommandNode(child) && !skill) {
        skill = child.getTextContent().replace(/^\//, '')
      }
    })
  })

  let text = root.getTextContent()

  // Strip the /command prefix from text so it's not sent as content
  if (skill) {
    text = text.replace(new RegExp(`^\\/${skill}\\s*`), '')
  }

  return { text, references, skill }
}

export default function SubmitOnEnterPlugin({
  onSubmit,
  isStreaming,
  allowEmptySubmit = false,
}: SubmitOnEnterPluginProps): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        if (event?.shiftKey || event?.isComposing) {
          return false
        }

        if (isStreaming) {
          event?.preventDefault()
          return true
        }

        let text = ''
        let references: Reference[] = []
        let skill: string | undefined

        editor.getEditorState().read(() => {
          const result = extractContent()
          text = result.text
          references = result.references
          skill = result.skill
        })

        // Allow empty text when a skill is active or when allowEmptySubmit is set (e.g. image attachments)
        if (text.trim().length === 0 && !skill && !allowEmptySubmit) {
          event?.preventDefault()
          return true
        }

        event?.preventDefault()
        onSubmit(text, references, skill)

        editor.update(() => {
          const root = $getRoot()
          root.clear()
          root.append($createParagraphNode())
        })

        return true
      },
      COMMAND_PRIORITY_HIGH
    )
  }, [editor, onSubmit, isStreaming, allowEmptySubmit])

  return null
}
