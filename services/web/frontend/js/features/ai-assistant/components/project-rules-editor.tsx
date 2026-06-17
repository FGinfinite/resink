import React, { memo, useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react'
import { useProjectContext } from '@/shared/context/project-context'
import * as aiApi from '../api/ai-api'
import OLButton from '@/shared/components/ol/ol-button'
import { hardenedRehypePlugins } from '../utils/streamdown-plugins'
import '../../../../stylesheets/ai-tailwind.css'

const StreamdownComponent = lazy(() =>
  import('streamdown').then(mod => ({ default: mod.Streamdown }))
)

interface ProjectRulesEditorProps {
  isOpen: boolean
  onClose: () => void
}

const DEFAULT_MAX_LENGTH = 10000

const ProjectRulesEditor = memo(function ProjectRulesEditor({
  isOpen,
  onClose,
}: ProjectRulesEditorProps) {
  const { projectId } = useProjectContext()
  const [content, setContent] = useState('')
  const [activeTab, setActiveTab] = useState<'edit' | 'preview'>('edit')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [maxLength, setMaxLength] = useState(DEFAULT_MAX_LENGTH)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    setSaveStatus('idle')
    aiApi
      .getProjectRules(projectId)
      .then(data => {
        setContent(data.content || '')
        if (typeof data.maxLength === 'number') setMaxLength(data.maxLength)
      })
      .catch(() => setContent(''))
      .finally(() => setLoading(false))
  }, [isOpen, projectId])

  // Cleanup save status timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onClose])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveStatus('idle')
    try {
      await aiApi.updateProjectRules(projectId, content)
      setSaveStatus('saved')
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
    } catch {
      setSaveStatus('error')
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000)
    } finally {
      setSaving(false)
    }
  }, [projectId, content])

  if (!isOpen) return null

  return (
    <div className="ai-project-rules-dropdown" ref={dropdownRef}>
      <div className="ai-project-rules-header">
        <span>项目规则</span>
        <div className="ai-project-rules-tabs">
          <button
            className={activeTab === 'edit' ? 'active' : ''}
            onClick={() => setActiveTab('edit')}
          >
            编辑
          </button>
          <button
            className={activeTab === 'preview' ? 'active' : ''}
            onClick={() => setActiveTab('preview')}
          >
            预览
          </button>
        </div>
      </div>
      <div className="ai-project-rules-body">
        {loading ? (
          <div className="ai-project-rules-loading">加载中...</div>
        ) : activeTab === 'edit' ? (
          <textarea
            className="ai-project-rules-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            maxLength={maxLength}
            placeholder="在此编写项目级 Markdown 指令，AI 会在每次对话中遵循这些规则..."
          />
        ) : (
          <div className="ai-project-rules-preview ai-streamdown-root">
            {content ? (
              <Suspense fallback={<div>加载预览...</div>}>
                <StreamdownComponent mode="static" controls={false} rehypePlugins={hardenedRehypePlugins} className="ai-streamdown-root">
                  {content}
                </StreamdownComponent>
              </Suspense>
            ) : (
              <span style={{ opacity: 0.5 }}>暂无内容</span>
            )}
          </div>
        )}
      </div>
      <div className="ai-project-rules-footer">
        <span className="ai-project-rules-count">
          {content.length} / {maxLength}
        </span>
        {saveStatus === 'saved' && <span className="ai-project-rules-saved">已保存</span>}
        {saveStatus === 'error' && <span className="ai-project-rules-error">保存失败</span>}
        <OLButton
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存'}
        </OLButton>
      </div>
    </div>
  )
})

export default ProjectRulesEditor
