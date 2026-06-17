/**
 * CommandTextNode – a styled TextNode for slash commands (e.g. /review).
 *
 * Follows the same pattern as @lexical/hashtag's HashtagNode:
 * - Extends TextNode (not DecoratorNode)
 * - isTextEntity() = true so registerLexicalTextEntity can manage it
 * - canInsertTextBefore() = false to prevent merging with preceding text
 * - createDOM() applies a CSS class for visual distinction
 */

import {
  TextNode,
  $applyNodeReplacement,
  addClassNamesToElement,
  type LexicalNode,
  type NodeKey,
  type EditorConfig,
  type SerializedTextNode,
} from 'lexical'

export class CommandTextNode extends TextNode {
  static getType(): string {
    return 'command'
  }

  static clone(node: CommandTextNode): CommandTextNode {
    return new CommandTextNode(node.__text, node.__key)
  }

  constructor(text: string, key?: NodeKey) {
    super(text, key)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config)
    addClassNamesToElement(el, 'ai-command-text')
    return el
  }

  /**
   * Mark as a text entity so registerLexicalTextEntity handles
   * automatic conversion between TextNode <-> CommandTextNode.
   */
  isTextEntity(): true {
    return true
  }

  /**
   * Prevent text typed immediately before the command from merging
   * into this node.
   */
  canInsertTextBefore(): false {
    return false
  }

  static importJSON(serializedNode: SerializedTextNode): CommandTextNode {
    return $createCommandNode(serializedNode.text)
  }

  exportJSON(): SerializedTextNode {
    return {
      ...super.exportJSON(),
      type: 'command',
    }
  }
}

export function $createCommandNode(text: string): CommandTextNode {
  return $applyNodeReplacement(new CommandTextNode(text))
}

export function $isCommandNode(
  node: LexicalNode | null | undefined
): node is CommandTextNode {
  return node instanceof CommandTextNode
}
