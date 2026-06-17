/**
 * Slash Command Plugin – shows a skill picker popover when the user types "/"
 * at the beginning of the input.
 *
 * Uses LexicalTypeaheadMenuPlugin (same mechanism as the @mention plugin)
 * with a custom trigger function that only activates at the start of the editor.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TextNode,
  $createTextNode,
  $getRoot,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  BLUR_COMMAND,
  FOCUS_COMMAND,
} from 'lexical'
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuTextMatch,
} from '@lexical/react/LexicalTypeaheadMenuPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import MaterialIcon from '@/shared/components/material-icon'
import { $createCommandNode } from './command-node'
import {
  SKILL_DEFINITIONS,
  type SkillDefinition,
} from './skill-registry'

class CommandOption extends MenuOption {
  name: string
  label: string
  icon: string
  description?: string

  constructor(skill: SkillDefinition) {
    super(skill.name)
    this.name = skill.name
    this.label = skill.label
    this.icon = skill.icon
    this.description = skill.description
  }
}

const ALL_OPTIONS = SKILL_DEFINITIONS.map(s => new CommandOption(s))

/**
 * Custom trigger: only fires when the FULL editor content starts with "/"
 * and the cursor is within that leading slash-word.
 */
function useSlashTrigger() {
  const [editor] = useLexicalComposerContext()

  const triggerFn = useCallback(
    (text: string): MenuTextMatch | null => {
      // `text` is the text of the current TextNode before the cursor.
      // We need to verify the slash is at the very start of the editor.
      let fullText = ''
      editor.getEditorState().read(() => {
        fullText = $getRoot().getTextContent()
      })

      // Only trigger if the whole input starts with /
      if (!fullText.startsWith('/')) {
        return null
      }

      // Match the "/" plus trailing word chars in the current text node
      const match = text.match(/^\/([\w-]*)$/)
      if (!match) {
        return null
      }

      return {
        leadOffset: 0,
        matchingString: match[1], // the part after "/"
        replaceableString: match[0], // the full "/xxx"
      }
    },
    [editor]
  )

  return triggerFn
}

export default function SlashCommandPlugin(): React.JSX.Element | null {
  const [queryString, setQueryString] = useState<string | null>(null)
  const triggerFn = useSlashTrigger()
  const [editor] = useLexicalComposerContext()
  const [editorFocused, setEditorFocused] = useState(true)

  // Close typeahead popover when editor loses focus
  useEffect(() => {
    const unregBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        setEditorFocused(false)
        return false
      },
      COMMAND_PRIORITY_LOW
    )
    const unregFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        setEditorFocused(true)
        return false
      },
      COMMAND_PRIORITY_LOW
    )
    return () => {
      unregBlur()
      unregFocus()
    }
  }, [editor])

  const options = useMemo(() => {
    if (queryString === null) return []
    if (queryString === '') return ALL_OPTIONS
    const q = queryString.toLowerCase()
    return ALL_OPTIONS.filter(
      opt =>
        opt.name.toLowerCase().includes(q) ||
        opt.label.toLowerCase().includes(q)
    )
  }, [queryString])

  const onSelectOption = useCallback(
    (
      selectedOption: CommandOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void
    ) => {
      if (nodeToReplace) {
        const commandNode = $createCommandNode(`/${selectedOption.name}`)
        const spaceNode = $createTextNode(' ')
        nodeToReplace.replace(commandNode)
        commandNode.insertAfter(spaceNode)
        spaceNode.select()
      }
      closeMenu()
    },
    []
  )

  const onQueryChange = useCallback((matchingString: string | null) => {
    setQueryString(matchingString)
  }, [])

  return (
    <LexicalTypeaheadMenuPlugin<CommandOption>
      onQueryChange={onQueryChange}
      onSelectOption={onSelectOption}
      triggerFn={triggerFn}
      options={options}
      commandPriority={COMMAND_PRIORITY_CRITICAL}
      menuRenderFn={(
        anchorElementRef,
        { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options: menuOptions }
      ) => {
        if (menuOptions.length === 0 || !anchorElementRef.current) {
          return null
        }
        // Portal into .ai-chat-input so bottom:100% positions above the entire input area
        const chatInputEl = anchorElementRef.current.ownerDocument.querySelector('.ai-chat-input')
        if (!chatInputEl) return null

        return createPortal(
          <div
            className={`ai-typeahead-popover${!editorFocused ? ' ai-typeahead-popover--hidden' : ''}`}
            onMouseDown={e => e.preventDefault()}
          >
            <div className="ai-typeahead-list">
              {menuOptions.map((option, index) => (
                <div
                  key={option.key}
                  ref={el => option.setRefElement(el)}
                  className={`ai-typeahead-option${
                    selectedIndex === index
                      ? ' ai-typeahead-option-selected'
                      : ''
                  }`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={selectedIndex === index}
                  onClick={() => selectOptionAndCleanUp(option)}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === 'Tab' || e.key === ' ') {
                      e.preventDefault()
                      selectOptionAndCleanUp(option)
                    }
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <span className="ai-typeahead-icon">
                    <MaterialIcon type={option.icon} />
                  </span>
                  <span className="ai-typeahead-body">
                    <span className="ai-typeahead-row">
                      <span className="ai-typeahead-text">/{option.name}</span>
                      <span className="ai-typeahead-label">{option.label}</span>
                    </span>
                    {option.description && (
                      <span className="ai-typeahead-desc">{option.description}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <div className="ai-typeahead-footer">
              <span><kbd>Tab</kbd> / <kbd>↵</kbd> select</span>
              <span><kbd>↑↓</kbd> navigate</span>
              <span><kbd>Esc</kbd> close</span>
            </div>
          </div>,
          chatInputEl
        )
      }}
    />
  )
}
