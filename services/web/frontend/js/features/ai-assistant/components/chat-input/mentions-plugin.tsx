import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  TextNode,
  $createTextNode,
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
import { Searcher } from 'fast-fuzzy'
import MaterialIcon from '@/shared/components/material-icon'
import { $createMentionNode } from './mention-node'
import { searchFiles } from '../../api/ai-api'

interface MentionsPluginProps {
  projectId: string
}

interface FileEntry {
  path: string
  type: 'doc' | 'file'
}

class MentionOption extends MenuOption {
  path: string
  fileType: 'doc' | 'file'

  constructor(path: string, fileType: 'doc' | 'file') {
    super(path)
    this.path = path
    this.fileType = fileType
  }
}

const MAX_RESULTS = 8
const DEBOUNCE_MS = 300

function getIconForFileType(fileType: 'doc' | 'file'): string {
  return fileType === 'doc' ? 'description' : 'attach_file'
}

export default function MentionsPlugin({
  projectId,
}: MentionsPluginProps): React.JSX.Element | null {
  const [queryString, setQueryString] = useState<string | null>(null)
  const [allFiles, setAllFiles] = useState<FileEntry[]>([])
  const [options, setOptions] = useState<MentionOption[]>([])
  const [editor] = useLexicalComposerContext()
  const [editorFocused, setEditorFocused] = useState(true)
  const cachedFilesRef = useRef<FileEntry[] | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFetchQueryRef = useRef<string>('')

  // Custom trigger: allow path characters (/, ., -, _) that the built-in
  // useBasicTypeaheadTriggerMatch rejects as punctuation.
  const checkForTriggerMatch = useCallback(
    (text: string): MenuTextMatch | null => {
      // Match @ followed by file-path characters (word chars, /, ., -)
      const match = text.match(/(^|\s)(@([\w/.\\-]*))$/)
      if (!match) return null
      return {
        leadOffset: match.index! + match[1].length,
        matchingString: match[3],
        replaceableString: match[2],
      }
    },
    []
  )

  // Fetch files from backend with debouncing and caching
  const fetchFiles = useCallback(
    (query: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      // Use cache if available and query is empty (initial load)
      if (query === '' && cachedFilesRef.current) {
        setAllFiles(cachedFilesRef.current)
        return
      }

      debounceTimerRef.current = setTimeout(async () => {
        try {
          const files = await searchFiles(projectId, query)
          if (query === '') {
            cachedFilesRef.current = files
          }
          setAllFiles(files)
          lastFetchQueryRef.current = query
        } catch {
          // Silently handle fetch errors - keep existing results
        }
      }, DEBOUNCE_MS)
    },
    [projectId]
  )

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [])

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

  // Build fuzzy searcher from files
  const searcher = useMemo(() => {
    return new Searcher(allFiles, {
      keySelector: (entry: FileEntry) => entry.path,
      threshold: 0.5,
    })
  }, [allFiles])

  // Update options when query or files change
  useEffect(() => {
    if (queryString === null) {
      setOptions([])
      return
    }

    // Fetch files when query changes
    fetchFiles(queryString)
  }, [queryString, fetchFiles])

  // Filter options based on query using fuzzy search
  useEffect(() => {
    if (queryString === null) {
      setOptions([])
      return
    }

    let filtered: FileEntry[]
    if (queryString === '') {
      filtered = allFiles.slice(0, MAX_RESULTS)
    } else {
      filtered = searcher.search(queryString).slice(0, MAX_RESULTS)
    }

    setOptions(
      filtered.map(entry => new MentionOption(entry.path, entry.type))
    )
  }, [allFiles, queryString, searcher])

  const onSelectOption = useCallback(
    (
      selectedOption: MentionOption,
      nodeToReplace: TextNode | null,
      closeMenu: () => void
    ) => {
      if (nodeToReplace) {
        const mentionNode = $createMentionNode(
          `@${selectedOption.path}`,
          'file',
          selectedOption.path
        )
        const spaceNode = $createTextNode(' ')
        nodeToReplace.replace(mentionNode)
        mentionNode.insertAfter(spaceNode)
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
    <LexicalTypeaheadMenuPlugin<MentionOption>
      onQueryChange={onQueryChange}
      onSelectOption={onSelectOption}
      triggerFn={checkForTriggerMatch}
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
            role="presentation"
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
                    <MaterialIcon type={getIconForFileType(option.fileType)} />
                  </span>
                  <span className="ai-typeahead-body">
                    <span className="ai-typeahead-row">
                      <span className="ai-typeahead-text">{option.path}</span>
                      <span className="ai-typeahead-label">{option.fileType === 'doc' ? 'LaTeX' : 'File'}</span>
                    </span>
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
