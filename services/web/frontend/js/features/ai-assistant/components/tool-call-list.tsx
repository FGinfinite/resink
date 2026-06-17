/**
 * Tool Call List Component
 * Renders tool call status lines in the AI Assistant message flow.
 * All tools use the expandable pattern for full transparency.
 */

import { useCallback, useContext, useState, Suspense, lazy } from 'react'
import MaterialIcon from '@/shared/components/material-icon'
import OLSpinner from '@/shared/components/ol/ol-spinner'
import InlineDiffPreview from './inline-diff-preview'
import { EditorViewContext } from '@/features/ide-react/context/editor-view-context'
import { EditorView } from '@codemirror/view'
import type { ToolCallEntry, ContentBlock, PendingChange } from '../types/ai-types'
import { hardenedRehypePlugins } from '../utils/streamdown-plugins'
import '../../../../stylesheets/ai-tailwind.css'

const StreamdownComponent = lazy(() =>
  import('streamdown').then(mod => ({ default: mod.Streamdown }))
)

// ============================================================================
// Tool Renderer Registry
// ============================================================================

interface ToolRendererConfig {
  icon: string
  renderRunning: (args: Record<string, unknown>) => string
  renderCompleted: (args: Record<string, unknown>, data?: Record<string, unknown>) => string
  renderError?: (args: Record<string, unknown>, error?: string) => string
  hidden?: (entry: ToolCallEntry) => boolean
  /** Whether to show InlineDiffPreview (for edit/delete with change data) */
  hasDiff?: boolean
}

function formatPath(args: Record<string, unknown>, data?: Record<string, unknown>): string {
  return (data?.path || args.path || args.filePath || '文档') as string
}

const TOOL_RENDERERS: Record<string, ToolRendererConfig> = {
  read_document: {
    icon: 'description',
    renderRunning: (args) => {
      const path = args.path || args.filePath
      const heading = args.heading
      const offset = args.offset as number | undefined
      if (heading) return `正在读取 ${path || '文档'} 的「${heading as string}」...`
      if (offset) return `正在读取 ${path || '文档'} (从第 ${offset} 行)...`
      if (path) return `正在读取 ${path as string} ...`
      return '正在读取文档...'
    },
    renderCompleted: (args, data) => {
      const path = formatPath(args, data)
      const heading = data?.heading as string | undefined
      const truncated = data?.truncated as boolean | undefined
      const returnedLines = data?.returnedLines as number | undefined
      const totalLines = data?.totalLines as number | undefined

      if (heading) {
        const start = data?.headingStartLine
        const end = data?.headingEndLine
        return `已读取 ${path}「${heading}」(第 ${start}-${end} 行)`
      }

      const offset = args.offset as number | undefined
      if (offset && totalLines) {
        const endLine = offset + (returnedLines || 0) - 1
        if (truncated) {
          return `已读取 ${path} 第 ${offset}-${endLine} 行 (共 ${totalLines} 行)`
        }
        return `已读取 ${path} 第 ${offset}-${totalLines} 行 (共 ${totalLines} 行)`
      }

      if (truncated && returnedLines && totalLines) {
        return `已读取 ${path} (前 ${returnedLines} 行，共 ${totalLines} 行)`
      }

      if (totalLines) return `已读取 ${path} (${totalLines} 行)`
      return `已读取 ${path}`
    },
  },

  list_files: {
    icon: 'folder_open',
    renderRunning: (args) => {
      const pattern = args.pattern
      if (pattern) return `正在查找 ${pattern as string} ...`
      return '正在浏览项目文件...'
    },
    renderCompleted: (_args, data) => {
      const count = data?.count ?? 0
      return `已列出 ${count} 个文件`
    },
  },

  search_project: {
    icon: 'search',
    renderRunning: (args) => {
      const pattern = args.pattern as string
      const path = args.path as string | undefined
      const glob = args.glob as string | undefined
      if (path) return `正在搜索 ${path} 中的「${pattern}」...`
      if (glob) return `正在搜索 ${glob} 文件中的「${pattern}」...`
      return `正在全项目搜索「${pattern}」...`
    },
    renderCompleted: (args, data) => {
      const matchCount = data?.matchCount as number ?? 0
      const fileCount = data?.fileCount as number ?? 0
      const pattern = args.pattern as string
      if (matchCount === 0) return `未找到「${pattern}」的匹配`
      return `找到 ${matchCount} 个匹配，涉及 ${fileCount} 个文件`
    },
  },

  edit_document: {
    icon: 'edit_note',
    hasDiff: true,
    renderRunning: (args) => {
      const path = args.path || args.filePath
      if (path) return `正在准备编辑 ${path as string} ...`
      return '正在准备编辑...'
    },
    renderCompleted: (args, data) => {
      const change = data?.change as Record<string, unknown> | undefined
      const changeType = change?.type as string | undefined
      const status = data?.status as string | undefined
      const path = change?.path || change?.docPath || args.path || args.filePath || '文档'
      const verb = changeType === 'create' ? '创建' : '编辑'
      if (status === 'accepted') return `已应用${verb}: ${path as string}`
      if (status === 'rejected') return `已拒绝${verb}: ${path as string}`
      return `已生成${verb}方案: ${path as string}`
    },
  },

  delete_file: {
    icon: 'delete',
    hasDiff: true,
    renderRunning: (args) => {
      const path = args.path
      if (path) return `正在准备删除 ${path as string} ...`
      return '正在准备删除...'
    },
    renderCompleted: (args, data) => {
      const change = data?.change as Record<string, unknown> | undefined
      const status = data?.status as string | undefined
      const path = change?.path || args.path || '文件'
      if (status === 'accepted') return `已删除: ${path as string}`
      if (status === 'rejected') return `已拒绝删除: ${path as string}`
      return `已生成删除方案: ${path as string}`
    },
  },

  activate_skill: {
    icon: 'psychology',
    renderRunning: (args) => `正在加载技能「${(args.name as string) || ''}」...`,
    renderCompleted: (args) => `已加载技能: ${(args.name as string) || ''}`,
  },

  delegate_task: {
    icon: 'group_work',
    renderRunning: (args) => `子 Agent「${(args.agent as string) || ''}」正在执行任务...`,
    renderCompleted: (args, data) => {
      const agent = (args.agent as string) || (data?.agent as string) || ''
      return `子 Agent「${agent}」任务完成`
    },
  },
}

const DEFAULT_RENDERER: ToolRendererConfig = {
  icon: 'build_circle',
  renderRunning: (args) => {
    const keys = Object.keys(args)
    return keys.length > 0 ? `正在执行 ${keys.join(', ')}...` : '正在执行...'
  },
  renderCompleted: () => '执行完成',
}

// ============================================================================
// Components
// ============================================================================

function getRenderer(tool: string): ToolRendererConfig {
  return TOOL_RENDERERS[tool] || DEFAULT_RENDERER
}

function getToolCallText(entry: ToolCallEntry, renderer: ToolRendererConfig): string {
  const isRunning = entry.status === 'running'
  const isError = entry.status === 'error'
  const isInterrupted = entry.status === 'interrupted'

  if (isRunning) {
    return renderer.renderRunning(entry.arguments)
  } else if (isInterrupted) {
    return renderer.renderRunning(entry.arguments).replace(/\.{3}$/, '') + '（已中断）'
  } else if (isError) {
    return renderer.renderError?.(entry.arguments, entry.result?.error)
      ?? `执行失败: ${entry.result?.error || '未知错误'}`
  } else {
    return renderer.renderCompleted(entry.arguments, entry.result?.data)
  }
}

const MAX_OUTPUT_PREVIEW_LINES = 30

function ToolOutputPreview({ output }: { output: string }) {
  const lines = output.split('\n')
  const truncated = lines.length > MAX_OUTPUT_PREVIEW_LINES
  const displayLines = truncated ? lines.slice(0, MAX_OUTPUT_PREVIEW_LINES) : lines

  return (
    <div className="ai-tool-output-preview">
      {displayLines.map((line, index) => (
        <div key={index} className="ai-tool-output-line">
          {line}
        </div>
      ))}
      {truncated && (
        <div className="ai-tool-output-truncated">
          ... {lines.length - MAX_OUTPUT_PREVIEW_LINES} more lines
        </div>
      )}
    </div>
  )
}

function ExpandableToolCallItem({ entry }: { entry: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(false)
  const editorViewCtx = useContext(EditorViewContext)
  const renderer = getRenderer(entry.tool)
  const isRunning = entry.status === 'running'
  const isError = entry.status === 'error'
  const isCompleted = entry.status === 'completed'
  const isInterrupted = entry.status === 'interrupted'
  const text = getToolCallText(entry, renderer)

  const change = entry.result?.data?.change as PendingChange | undefined
  const output = entry.result?.output as string | undefined

  // Can expand if completed and has either a diff or output text
  const hasDiffContent = renderer.hasDiff && change != null
  const hasOutputContent = isCompleted && output != null && output.length > 0
  const hasErrorContent = isError && entry.result?.error != null
  const canExpand = hasDiffContent || hasOutputContent || hasErrorContent

  const handleToggle = () => {
    if (canExpand) setExpanded(prev => !prev)
  }

  const handleJumpToEditor = useCallback(() => {
    const view = editorViewCtx?.view
    if (!view || !change?.position) return
    const pos = change.position.start
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
  }, [editorViewCtx?.view, change])

  const canJump = change?.position != null && editorViewCtx?.view != null

  return (
    <div className={`ai-tool-call-expandable ai-tool-call-${entry.status}`}>
      <div
        className={`ai-tool-call-header ${canExpand ? 'ai-tool-call-header-clickable' : ''}`}
        onClick={handleToggle}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onKeyDown={canExpand ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleToggle() } : undefined}
      >
        <span className="ai-tool-call-icon">
          {isRunning ? (
            <OLSpinner size="sm" />
          ) : (
            <MaterialIcon type={isError ? 'error_outline' : isInterrupted ? 'stop_circle' : renderer.icon} />
          )}
        </span>
        <span className="ai-tool-call-text">{text}</span>
        {canExpand && (
          <span className="ai-tool-call-expand-icon">
            <MaterialIcon type={expanded ? 'expand_less' : 'expand_more'} />
          </span>
        )}
      </div>
      {expanded && (
        <div className="ai-tool-call-detail">
          {hasDiffContent && change && (
            <>
              <InlineDiffPreview change={change} />
              {canJump && (
                <button
                  type="button"
                  className="ai-tool-call-jump-btn"
                  onClick={handleJumpToEditor}
                >
                  <MaterialIcon type="my_location" />
                  <span>跳转到编辑器</span>
                </button>
              )}
            </>
          )}
          {!hasDiffContent && hasOutputContent && output && (
            <ToolOutputPreview output={output} />
          )}
          {hasErrorContent && !hasOutputContent && (
            <div className="ai-tool-output-error">
              {entry.result?.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolCallItem({ entry, childParts }: { entry: ToolCallEntry; childParts?: ContentBlock[] }) {
  const renderer = getRenderer(entry.tool)

  if (renderer.hidden?.(entry)) return null

  // If this is a delegate_task, always render as SubAgent block
  // (covers queued, running before childSessionId arrives, and completed states)
  if (entry.tool === 'delegate_task') {
    return <SubAgentTaskBlock entry={entry} childParts={childParts} />
  }

  return <ExpandableToolCallItem entry={entry} />
}

// ============================================================================
// SubAgent Task Block
// ============================================================================

function SubAgentTaskBlock({ entry, childParts }: { entry: ToolCallEntry; childParts?: ContentBlock[] }) {
  const [expanded, setExpanded] = useState(false)
  const isQueued = entry.status === 'queued'
  const isRunning = entry.status === 'running'
  const isError = entry.status === 'error'
  const isInterrupted = entry.status === 'interrupted'
  const agentName = (entry.arguments.agent as string) || (entry.result?.data?.agent as string) || 'unknown'
  const taskDescription = entry.arguments.task as string | undefined
  const resultOutput = entry.result?.output as string | undefined
  const isCompleted = entry.status === 'completed'
  const hasResult = isCompleted && resultOutput != null && resultOutput.length > 0 && resultOutput !== '(Sub-agent returned no text)'

  const childToolCalls = (childParts || []).filter(
    (b): b is ContentBlock & { type: 'tool_call' } => b.type === 'tool_call'
  )
  const completedTools = childToolCalls.filter(b => b.entry.status !== 'running' && b.entry.status !== 'interrupted')
  const runningTools = childToolCalls.filter(b => b.entry.status === 'running')
  const currentTool = runningTools[runningTools.length - 1] || completedTools[completedTools.length - 1]

  const toolCount = childToolCalls.length

  const lastChildBlock = childParts?.[childParts.length - 1]
  const isChildThinking = isRunning && lastChildBlock?.type === 'thinking'

  // Summary text
  let summaryText: string
  if (isQueued) {
    summaryText = `子 Agent「${agentName}」等待执行`
  } else if (isRunning) {
    summaryText = isChildThinking
      ? `子 Agent「${agentName}」正在思考...`
      : `子 Agent「${agentName}」执行中...`
    if (toolCount > 0) {
      summaryText += ` (${toolCount} 工具调用)`
    }
  } else if (isInterrupted) {
    summaryText = `子 Agent「${agentName}」已中断`
    if (toolCount > 0) {
      summaryText += ` (${toolCount} 工具调用)`
    }
  } else if (isError) {
    summaryText = `子 Agent「${agentName}」执行失败`
  } else {
    summaryText = `子 Agent「${agentName}」任务完成`
    if (toolCount > 0) {
      summaryText += ` (${toolCount} 工具调用)`
    }
  }

  // Current tool display
  const currentToolText = currentTool
    ? getToolCallText(currentTool.entry, getRenderer(currentTool.entry.tool))
    : null

  return (
    <div className={`ai-tool-call-expandable ai-tool-call-${entry.status} ai-subagent-block`}>
      <div
        className="ai-tool-call-header ai-tool-call-header-clickable"
        onClick={() => setExpanded(prev => !prev)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setExpanded(prev => !prev) }}
      >
        <span className="ai-tool-call-icon">
          {isRunning ? (
            <OLSpinner size="sm" />
          ) : isQueued ? (
            <MaterialIcon type="schedule" />
          ) : (
            <MaterialIcon type={isError ? 'error_outline' : isInterrupted ? 'stop_circle' : 'group_work'} />
          )}
        </span>
        <span className="ai-tool-call-text">
          {summaryText}
        </span>
        <span className="ai-tool-call-expand-icon">
          <MaterialIcon type={expanded ? 'expand_less' : 'expand_more'} />
        </span>
      </div>
      {/* Task description preview (when collapsed) */}
      {!expanded && taskDescription && (
        <div className="ai-subagent-task-preview">
          <span className="ai-subagent-task-label">指令: </span>
          <span className="ai-subagent-task-truncated">
            {taskDescription.length > 80 ? taskDescription.slice(0, 80) + '...' : taskDescription}
          </span>
        </div>
      )}
      {/* Result preview (when collapsed) */}
      {!expanded && hasResult && (
        <div className="ai-subagent-result-preview">
          <span className="ai-subagent-task-label">结果: </span>
          <span className="ai-subagent-task-truncated">
            {resultOutput!.length > 100 ? resultOutput!.slice(0, 100) + '...' : resultOutput}
          </span>
        </div>
      )}
      {/* Current/last tool preview (when collapsed) */}
      {!expanded && currentToolText && (
        <div className="ai-subagent-current-tool">
          <span className="ai-subagent-current-tool-prefix">└ </span>
          {currentToolText}
        </div>
      )}
      {/* Expanded: full task description */}
      {expanded && taskDescription && (
        <div className="ai-subagent-task-detail">
          <div className="ai-subagent-task-detail-label">任务说明</div>
          <div className="ai-subagent-task-detail-content">{taskDescription}</div>
        </div>
      )}
      {/* Expanded: sub-agent result output */}
      {expanded && hasResult && (
        <div className="ai-subagent-result-detail">
          <div className="ai-subagent-task-detail-label">执行结果</div>
          <div className="ai-subagent-result-content ai-streamdown-root">
            <Suspense fallback={<div>{resultOutput}</div>}>
              <StreamdownComponent mode="static" controls={false} rehypePlugins={hardenedRehypePlugins} className="ai-streamdown-root">
                {resultOutput}
              </StreamdownComponent>
            </Suspense>
          </div>
        </div>
      )}
      {/* Expanded: show all child tool calls */}
      {expanded && childToolCalls.length > 0 && (
        <div className="ai-subagent-detail">
          {childToolCalls.map(block => (
            <ExpandableToolCallItem key={block.entry.id} entry={block.entry} />
          ))}
        </div>
      )}
      {/* Expanded but no tool calls */}
      {expanded && childToolCalls.length === 0 && (
        <div className="ai-subagent-detail ai-subagent-detail-empty">
          {isQueued ? '等待执行...' : isRunning ? '子 Agent 正在分析任务...' : '无工具调用'}
        </div>
      )}
    </div>
  )
}
