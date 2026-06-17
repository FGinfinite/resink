import React, { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useProjectContext } from '@/shared/context/project-context'
import { useAIAssistantContext } from '../context/ai-assistant-context'
import * as aiApi from '../api/ai-api'
import type { SessionSummary } from '../types/ai-types'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'

interface SessionListProps {
  isOpen: boolean
  onClose: () => void
  currentSessionId: string | undefined
  isStreaming: boolean
}

const SessionList = memo(function SessionList({
  isOpen,
  onClose,
  currentSessionId,
  isStreaming,
}: SessionListProps) {
  const { t } = useTranslation()
  const { projectId } = useProjectContext()
  const { switchSession, renameSession, deleteSession } =
    useAIAssistantContext()

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Fetch sessions when opened
  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    aiApi
      .listSessions(projectId)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false))
  }, [isOpen, projectId])

  // Focus input when editing
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onClose])

  const handleSelect = useCallback(
    async (sessionId: string) => {
      if (sessionId === currentSessionId || isStreaming) return
      onClose()
      await switchSession(sessionId)
    },
    [currentSessionId, isStreaming, onClose, switchSession]
  )

  const handleStartEdit = useCallback(
    (e: React.MouseEvent, session: SessionSummary) => {
      e.stopPropagation()
      setEditingId(session.id)
      setEditTitle(session.title)
    },
    []
  )

  const handleSaveEdit = useCallback(
    async (sessionId: string) => {
      const trimmed = editTitle.trim()
      if (!trimmed) {
        setEditingId(null)
        return
      }
      try {
        const newTitle = await aiApi.updateSession(sessionId, trimmed)
        setSessions(prev =>
          prev.map(s => (s.id === sessionId ? { ...s, title: newTitle } : s))
        )
        if (sessionId === currentSessionId) {
          await renameSession(newTitle)
        }
      } catch {
        // ignore
      }
      setEditingId(null)
    },
    [editTitle, currentSessionId, renameSession]
  )

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent, sessionId: string) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSaveEdit(sessionId)
      } else if (e.key === 'Escape') {
        setEditingId(null)
      }
    },
    [handleSaveEdit]
  )

  const handleDelete = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation()
      if (sessionId === currentSessionId) {
        // Delete current session via context (triggers new session creation)
        await deleteSession()
        onClose()
      } else {
        try {
          await aiApi.deleteSession(sessionId)
          setSessions(prev => prev.filter(s => s.id !== sessionId))
        } catch {
          // ignore
        }
      }
    },
    [currentSessionId, deleteSession, onClose]
  )

  if (!isOpen) return null

  return (
    <div className="ai-session-list-dropdown" ref={dropdownRef}>
      <div className="ai-session-list-header">
        {t('session_history', 'Session History')}
      </div>

      {loading && (
        <div className="ai-session-list-loading">
          {t('loading', 'Loading...')}
        </div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="ai-session-list-empty">
          {t('no_sessions', 'No sessions yet')}
        </div>
      )}

      {!loading && (
        <ul className="ai-session-list-items" role="listbox">
          {sessions.map(session => (
            <li
              key={session.id}
              className={`ai-session-list-item ${
                session.id === currentSessionId
                  ? 'ai-session-list-item-active'
                  : ''
              }`}
              role="option"
              tabIndex={0}
              aria-selected={session.id === currentSessionId}
              onClick={() => handleSelect(session.id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleSelect(session.id)
                }
              }}
            >
              {editingId === session.id ? (
                <input
                  ref={inputRef}
                  className="ai-session-rename-input"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onBlur={() => handleSaveEdit(session.id)}
                  onKeyDown={e => handleEditKeyDown(e, session.id)}
                  onClick={e => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="ai-session-list-item-title">
                    {session.title}
                  </span>
                  <span className="ai-session-list-item-actions">
                    <OLButton
                      variant="ghost"
                      size="sm"
                      onClick={e => handleStartEdit(e, session)}
                      aria-label={t('rename', 'Rename')}
                    >
                      <MaterialIcon type="edit" />
                    </OLButton>
                    <OLButton
                      variant="ghost"
                      size="sm"
                      onClick={e => handleDelete(e, session.id)}
                      aria-label={t('delete', 'Delete')}
                    >
                      <MaterialIcon type="delete" />
                    </OLButton>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

export default SessionList
