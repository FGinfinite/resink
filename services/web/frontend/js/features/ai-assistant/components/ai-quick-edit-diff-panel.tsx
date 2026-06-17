import React, {
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { computeCharDiff, CharDiffSegment } from '../utils/diff-utils'

interface DiffPanelProps {
  oldText: string
  newText: string
  onApply: (finalText: string) => void
  onDiscard: () => void
}

interface SegmentState extends CharDiffSegment {
  excluded: boolean
  groupId: number
}

const AIQuickEditDiffPanel: FC<DiffPanelProps> = ({
  oldText,
  newText,
  onApply,
  onDiscard,
}) => {
  const panelRef = useRef<HTMLDivElement>(null)

  // Compute diff segments with group IDs
  const initialSegments = useMemo(() => {
    const raw = computeCharDiff(oldText, newText)
    const segments: SegmentState[] = []
    let groupId = 0

    for (let i = 0; i < raw.length; i++) {
      const seg = raw[i]
      if (seg.type === 'equal') {
        segments.push({ ...seg, excluded: false, groupId: -1 })
      } else {
        // Group adjacent removed+added segments
        const currentGroupId = groupId
        if (seg.type === 'removed') {
          segments.push({
            ...seg,
            excluded: false,
            groupId: currentGroupId,
          })
          // Check if next is 'added' -- pair them
          if (i + 1 < raw.length && raw[i + 1].type === 'added') {
            i++
            segments.push({
              ...raw[i],
              excluded: false,
              groupId: currentGroupId,
            })
          }
        } else {
          // 'added' without preceding 'removed'
          segments.push({
            ...seg,
            excluded: false,
            groupId: currentGroupId,
          })
        }
        groupId++
      }
    }
    return segments
  }, [oldText, newText])

  const [segments, setSegments] = useState<SegmentState[]>(initialSegments)

  // Reset segments when diff data changes
  useEffect(() => {
    setSegments(initialSegments)
  }, [initialSegments])

  // Click outside to discard
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node)
      ) {
        onDiscard()
      }
    }
    // Use setTimeout to avoid catching the click that triggered the diff
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleMouseDown)
    }, 100)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [onDiscard])

  // Escape to discard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDiscard()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDiscard])

  const toggleGroup = useCallback((groupId: number) => {
    if (groupId < 0) return
    setSegments(prev =>
      prev.map(seg =>
        seg.groupId === groupId ? { ...seg, excluded: !seg.excluded } : seg
      )
    )
  }, [])

  const buildFinalText = useCallback(() => {
    const parts: string[] = []
    for (const seg of segments) {
      if (seg.type === 'equal') {
        parts.push(seg.text)
      } else if (seg.excluded) {
        // Excluded: use original text (removed segments) or skip (added segments)
        if (seg.type === 'removed') {
          parts.push(seg.text)
        }
        // 'added' excluded -> skip
      } else {
        // Not excluded: use new text (added segments) or skip (removed segments)
        if (seg.type === 'added') {
          parts.push(seg.text)
        }
        // 'removed' not excluded -> skip (replaced by added)
      }
    }
    return parts.join('')
  }, [segments])

  const changeCount = useMemo(() => {
    const groupIds = new Set(
      segments
        .filter(s => s.groupId >= 0 && !s.excluded)
        .map(s => s.groupId)
    )
    return groupIds.size
  }, [segments])

  const totalGroups = useMemo(() => {
    const groupIds = new Set(
      segments.filter(s => s.groupId >= 0).map(s => s.groupId)
    )
    return groupIds.size
  }, [segments])

  return (
    <div className="ai-quick-edit-diff-panel" ref={panelRef}>
      <div className="ai-quick-edit-diff-content">
        {segments.map((seg, idx) => {
          if (seg.type === 'equal') {
            return (
              <span key={idx} className="ai-qe-diff-equal">
                {seg.text}
              </span>
            )
          }

          const isExcluded = seg.excluded
          const className =
            seg.type === 'removed'
              ? `ai-qe-diff-removed${isExcluded ? ' ai-qe-diff-excluded' : ''}`
              : `ai-qe-diff-added${isExcluded ? ' ai-qe-diff-excluded' : ''}`

          return (
            <span
              key={idx}
              className={className}
              onClick={() => toggleGroup(seg.groupId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleGroup(seg.groupId)
                }
              }}
              role="button"
              tabIndex={0}
              title={
                isExcluded
                  ? '\u70B9\u51FB\u5305\u542B\u6B64\u53D8\u66F4'
                  : '\u70B9\u51FB\u6392\u9664\u6B64\u53D8\u66F4'
              }
            >
              {seg.text}
            </span>
          )
        })}
      </div>
      <div className="ai-quick-edit-diff-footer">
        <span className="ai-quick-edit-diff-stats">
          {changeCount}/{totalGroups} 变更
        </span>
        <button
          className="ai-quick-edit-btn ai-quick-edit-btn-discard"
          onClick={onDiscard}
        >
          放弃
        </button>
        <button
          className="ai-quick-edit-btn ai-quick-edit-btn-apply"
          onClick={() => onApply(buildFinalText())}
        >
          应用
        </button>
      </div>
    </div>
  )
}

export default AIQuickEditDiffPanel
