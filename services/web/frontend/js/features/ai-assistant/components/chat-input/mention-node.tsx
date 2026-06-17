import React from 'react'
import {
  DecoratorNode,
  $applyNodeReplacement,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical'

export type SerializedMentionNode = Spread<
  {
    mentionText: string
    mentionType: 'file' | 'selection'
    filePath: string
    startLine?: number
    endLine?: number
    selectionText?: string
  },
  SerializedLexicalNode
>

export class MentionNode extends DecoratorNode<React.ReactElement> {
  __mentionText: string
  __mentionType: 'file' | 'selection'
  __filePath: string
  __startLine?: number
  __endLine?: number
  __selectionText?: string

  static getType(): string {
    return 'mention'
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(
      node.__mentionText,
      node.__mentionType,
      node.__filePath,
      {
        startLine: node.__startLine,
        endLine: node.__endLine,
        selectionText: node.__selectionText,
      },
      node.__key
    )
  }

  constructor(
    mentionText: string,
    mentionType: 'file' | 'selection',
    filePath: string,
    options?: {
      startLine?: number
      endLine?: number
      selectionText?: string
    },
    key?: NodeKey
  ) {
    super(key)
    this.__mentionText = mentionText
    this.__mentionType = mentionType
    this.__filePath = filePath
    this.__startLine = options?.startLine
    this.__endLine = options?.endLine
    this.__selectionText = options?.selectionText
  }

  createDOM(): HTMLElement {
    return document.createElement('span')
  }

  updateDOM(): false {
    return false
  }

  isInline(): boolean {
    return true
  }

  isKeyboardSelectable(): boolean {
    return false
  }

  getTextContent(): string {
    return this.__mentionText
  }

  decorate(): React.ReactElement {
    return (
      <span className="ai-mention-pill" data-mention-type={this.__mentionType}>
        {this.__mentionText}
      </span>
    )
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: 'mention',
      version: 1,
      mentionText: this.__mentionText,
      mentionType: this.__mentionType,
      filePath: this.__filePath,
      startLine: this.__startLine,
      endLine: this.__endLine,
      selectionText: this.__selectionText,
    }
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(
      serializedNode.mentionText,
      serializedNode.mentionType,
      serializedNode.filePath,
      {
        startLine: serializedNode.startLine,
        endLine: serializedNode.endLine,
        selectionText: serializedNode.selectionText,
      }
    )
  }
}

export function $createMentionNode(
  mentionText: string,
  mentionType: 'file' | 'selection',
  filePath: string,
  options?: {
    startLine?: number
    endLine?: number
    selectionText?: string
  }
): MentionNode {
  return $applyNodeReplacement(
    new MentionNode(mentionText, mentionType, filePath, options)
  )
}

export function $isMentionNode(
  node: LexicalNode | null | undefined
): node is MentionNode {
  return node instanceof MentionNode
}
