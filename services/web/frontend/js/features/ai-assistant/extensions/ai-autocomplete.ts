/**
 * AI Autocomplete Ghost Text Extension
 *
 * Renders LLM-generated completions as semi-transparent "ghost text" after the cursor.
 * - Tab to accept, Esc to dismiss
 * - Writing state machine: triggers after pause (3s flowing / 1.5s struggling)
 * - Skips when @codemirror/autocomplete dropdown is open
 * - Compartment-based dynamic enable/disable
 * - LRU prefix cache for instant re-display
 * - Streaming ghost text with progressive rendering
 */
import {
  Compartment,
  Extension,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Text,
  Transaction,
  TransactionSpec,
} from '@codemirror/state'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  keymap,
} from '@codemirror/view'
import { completionStatus } from '@codemirror/autocomplete'
import { fetchCompletionStream } from '../api/autocomplete-api'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MIN_PREFIX_LENGTH = 10
const MAX_PREFIX_CHARS = 2000
const MAX_SUFFIX_CHARS = 500
const ENHANCED_MAX_PREFIX_CHARS = 8000
const ENHANCED_MAX_SUFFIX_CHARS = 2000
const MAX_GHOST_TEXT_CHARS = 2000
const INITIAL_DELAY = 150
const STREAM_UPDATE_INTERVAL = 50

// Writing State Machine
const FLOW_GAP_MS = 400 // Keystroke gap threshold (ms), below this = flowing
const PAUSE_THRESHOLD_MS = 3000 // FLOWING -> trigger completion pause threshold
const STRUGGLE_THRESHOLD_MS = 1500 // STRUGGLING state lower trigger threshold
const STRUGGLE_DELETE_COUNT = 3 // Delete count to enter STRUGGLING
const STRUGGLE_WINDOW_MS = 120_000 // Delete count time window (2min)
const STRUGGLE_RADIUS = 50 // Delete position range (chars)
const EXTERNAL_COOLDOWN_MS = 5000 // Cooldown after large paste/remote write
const LARGE_INSERT_THRESHOLD = 80 // Chars to qualify as large insert

// ---------------------------------------------------------------------------
// LRU Prefix Cache
// ---------------------------------------------------------------------------
class LRUPrefixCache {
  private capacity: number
  private cache: Map<
    string,
    { completion: string; prefix: string; suffix: string; contextHash: string }
  >

  constructor(capacity = 50) {
    this.capacity = capacity
    this.cache = new Map()
  }

  lookup(
    prefix: string,
    suffix: string,
    contextHash: string
  ): string | null {
    // 1. Exact match — same prefix, return full completion
    const exact = this.cache.get(prefix)
    if (exact && exact.contextHash === contextHash) {
      // LRU: move to end
      this.cache.delete(prefix)
      this.cache.set(prefix, exact)
      return exact.completion
    }

    // 2. Prefix extension — user typed chars that match completion start
    //    Find the longest matching cached prefix for best accuracy
    let bestMatch: {
      key: string
      entry: { completion: string; prefix: string; suffix: string; contextHash: string }
      newlyTyped: string
    } | null = null

    for (const [key, entry] of this.cache) {
      if (
        prefix.startsWith(entry.prefix) &&
        prefix.length > entry.prefix.length
      ) {
        const newlyTyped = prefix.slice(entry.prefix.length)
        if (entry.completion.startsWith(newlyTyped)) {
          if (entry.suffix.slice(0, 64) !== suffix.slice(0, 64)) continue
          // Pick the longest prefix match (most precise)
          if (
            !bestMatch ||
            entry.prefix.length > bestMatch.entry.prefix.length
          ) {
            bestMatch = { key, entry, newlyTyped }
          }
        }
      }
    }

    if (bestMatch) {
      // LRU: move to end
      this.cache.delete(bestMatch.key)
      this.cache.set(bestMatch.key, bestMatch.entry)
      return bestMatch.entry.completion.slice(bestMatch.newlyTyped.length)
    }
    return null
  }

  set(
    prefix: string,
    entry: {
      completion: string
      prefix: string
      suffix: string
      contextHash: string
    }
  ): void {
    if (this.cache.size >= this.capacity) {
      // Delete oldest (first) entry
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(prefix, entry)
  }

  clear(): void {
    this.cache.clear()
  }
}

// ---------------------------------------------------------------------------
// Writing State Machine — intelligent trigger control
// ---------------------------------------------------------------------------
type WritingState = 'COLD' | 'FLOWING' | 'STRUGGLING' | 'EXTERNAL'

class WritingStateMachine {
  private state: WritingState = 'COLD'
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private externalTimer: ReturnType<typeof setTimeout> | null = null
  private lastKeystrokeTime = 0
  private editAnchor = -1
  private recentDeletes: Array<{ pos: number; time: number }> = []
  private triggerCallback: (() => void) | null = null
  private recentEdits: Array<{ from: number; to: number; timestamp: number }> =
    []

  private static readonly MAX_RECENT_EDITS = 3
  private static readonly RECENT_EDIT_EXPIRY_MS = 120_000 // 2 minutes

  setTriggerCallback(cb: () => void) {
    this.triggerCallback = cb
  }

  processUpdate(update: ViewUpdate) {
    // Focus loss → COLD
    if (!update.view.hasFocus) {
      this.transitionTo('COLD')
      return
    }

    const now = Date.now()
    const inExternalCooldown = this.state === 'EXTERNAL'
    let hadUserEdit = false

    for (const tr of update.transactions) {
      if (!tr.docChanged) continue

      // Classify the transaction
      let insertedChars = 0
      let deletedChars = 0
      let deletePos = -1

      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const del = toA - fromA
        const ins = inserted.length
        deletedChars += del
        insertedChars += ins
        if (del > 0 && deletePos === -1) {
          deletePos = fromA
        }
        // Track edit ranges for recent-edits context
        if (ins > 0 || del > 0) {
          this._recordEdit(fromA, fromA + ins)
        }
      })

      // Check for remote/external large inserts
      const isRemote = tr.annotation(Transaction.remote) === true
      const isPaste = tr.isUserEvent('input.paste')
      const isUserEdit = tr.isUserEvent('input') || tr.isUserEvent('delete')

      if (isRemote && !isUserEdit && insertedChars > LARGE_INSERT_THRESHOLD) {
        this.transitionTo('EXTERNAL')
        this.startExternalCooldown()
        return
      }

      if (isPaste && insertedChars > LARGE_INSERT_THRESHOLD) {
        this.transitionTo('EXTERNAL')
        this.startExternalCooldown()
        return
      }

      // During EXTERNAL cooldown, ignore user edits
      if (inExternalCooldown) continue
      if (!isUserEdit) continue
      hadUserEdit = true

      // User is typing — update edit anchor
      const cursorPos = update.view.state.selection.main.head
      if (this.editAnchor === -1) {
        this.editAnchor = cursorPos
      } else if (Math.abs(cursorPos - this.editAnchor) > 200) {
        // Jumped to a different area
        this.editAnchor = cursorPos
        this.transitionTo('COLD')
        this.recentDeletes = []
      }

      // Track deletes for struggle detection
      if (deletedChars > 0 && deletePos >= 0) {
        // Clean expired deletes
        this.recentDeletes = this.recentDeletes.filter(
          d => now - d.time < STRUGGLE_WINDOW_MS
        )
        // Only count deletes near current area
        this.recentDeletes.push({ pos: deletePos, time: now })

        // Count deletes within STRUGGLE_RADIUS of current position
        const nearbyDeletes = this.recentDeletes.filter(
          d => Math.abs(d.pos - cursorPos) < STRUGGLE_RADIUS
        )

        if (nearbyDeletes.length >= STRUGGLE_DELETE_COUNT) {
          this.transitionTo('STRUGGLING')
          this.resetPauseTimer(STRUGGLE_THRESHOLD_MS)
          this.lastKeystrokeTime = now
          return
        }
      }

      // Normal typing — check flow
      const gap = now - this.lastKeystrokeTime
      this.lastKeystrokeTime = now

      if (gap > 0 && gap < FLOW_GAP_MS) {
        // Fast typing — flowing
        if (this.state !== 'STRUGGLING') {
          this.transitionTo('FLOWING')
        }
      } else if (this.state === 'COLD') {
        // First keystroke or after long pause
        this.transitionTo('FLOWING')
      }
    }

    // Set up pause timer based on current state
    if (inExternalCooldown || !hadUserEdit) return
    if (this.state === 'FLOWING') {
      this.resetPauseTimer(PAUSE_THRESHOLD_MS)
    } else if (this.state === 'STRUGGLING') {
      this.resetPauseTimer(STRUGGLE_THRESHOLD_MS)
    }
  }

  private transitionTo(newState: WritingState) {
    if (newState === this.state) return
    this.state = newState
    if (newState === 'COLD' || newState === 'EXTERNAL') {
      this.clearPauseTimer()
      this.editAnchor = -1
      this.recentDeletes = []
    }
  }

  private resetPauseTimer(delayMs: number) {
    this.clearPauseTimer()
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null
      if (this.triggerCallback) {
        this.triggerCallback()
      }
      // After trigger, go back to COLD to await next typing session
      this.state = 'COLD'
      this.editAnchor = -1
      this.recentDeletes = []
    }, delayMs)
  }

  private clearPauseTimer() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer)
      this.pauseTimer = null
    }
  }

  private startExternalCooldown() {
    if (this.externalTimer) {
      clearTimeout(this.externalTimer)
    }
    this.externalTimer = setTimeout(() => {
      this.externalTimer = null
      if (this.state === 'EXTERNAL') {
        this.transitionTo('COLD')
      }
    }, EXTERNAL_COOLDOWN_MS)
  }

  private _recordEdit(from: number, to: number) {
    const now = Date.now()
    // Clean expired
    this.recentEdits = this.recentEdits.filter(
      e => now - e.timestamp < WritingStateMachine.RECENT_EDIT_EXPIRY_MS
    )
    // Merge overlapping ranges (50 char tolerance)
    const existing = this.recentEdits.find(
      e => !(to < e.from - 50 || from > e.to + 50)
    )
    if (existing) {
      existing.from = Math.min(existing.from, from)
      existing.to = Math.max(existing.to, to)
      existing.timestamp = now
    } else {
      this.recentEdits.push({ from, to, timestamp: now })
      // Evict oldest if over limit
      if (this.recentEdits.length > WritingStateMachine.MAX_RECENT_EDITS) {
        this.recentEdits.sort((a, b) => a.timestamp - b.timestamp)
        this.recentEdits.shift()
      }
    }
  }

  getRecentEditTexts(
    doc: Text
  ): Array<{ text: string; line: number }> {
    const now = Date.now()
    return this.recentEdits
      .filter(
        e => now - e.timestamp < WritingStateMachine.RECENT_EDIT_EXPIRY_MS
      )
      .filter(e => e.from >= 0 && e.to <= doc.length)
      .map(e => ({
        text: doc
          .sliceString(Math.max(0, e.from), Math.min(doc.length, e.to))
          .slice(0, 500), // max 500 chars per range
        line: doc.lineAt(e.from).number,
      }))
  }

  reset() {
    this.transitionTo('COLD')
    this.editAnchor = -1
    this.recentDeletes = []
  }

  destroy() {
    this.clearPauseTimer()
    if (this.externalTimer) {
      clearTimeout(this.externalTimer)
      this.externalTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// Facet — project context injected from React via Compartment
// ---------------------------------------------------------------------------
interface AutocompleteContext {
  projectId: string
  fileName: string
  onStatusChange?: (status: 'idle' | 'loading' | 'streaming', source?: 'auto' | 'enhanced') => void
}

const aiAutocompleteFacet = Facet.define<
  AutocompleteContext,
  AutocompleteContext
>({
  combine(values) {
    return (
      values[values.length - 1] || {
        projectId: '',
        fileName: '',
        onStatusChange: undefined,
      }
    )
  },
})

// ---------------------------------------------------------------------------
// StateEffect + StateField — ghost text state
// ---------------------------------------------------------------------------
interface GhostText {
  text: string
  pos: number
  /** Hash of the prefix+suffix context at request time, for stale detection */
  contextHash: string
  source?: 'auto' | 'enhanced'
}

const setGhostTextEffect = StateEffect.define<GhostText>()
const clearGhostTextEffect = StateEffect.define<void>()
const cancelAutocompleteEffect = StateEffect.define<void>()

const triggerEnhancedCompletionEffect = StateEffect.define<{
  selectedContext?: string
}>()

const ghostTextField = StateField.define<GhostText | null>({
  create() {
    return null
  },
  update(state, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setGhostTextEffect)) {
        return effect.value
      }
      if (effect.is(clearGhostTextEffect)) {
        return null
      }
    }
    if (tr.docChanged) {
      if (!state) return null
      // If the user typed text matching the start of the ghost text,
      // consume those characters and keep showing the remainder instantly
      if (tr.isUserEvent('input')) {
        let consumed = ''
        tr.changes.iterChanges(
          (fromA, toA, _fromB, _toB, inserted) => {
            // Only consider pure insertions at the ghost position
            if (fromA === state.pos && toA === state.pos && !consumed) {
              consumed = inserted.toString()
            }
          }
        )
        if (consumed && state.text.startsWith(consumed)) {
          const remaining = state.text.slice(consumed.length)
          if (remaining.length > 0) {
            return {
              text: remaining,
              pos: tr.changes.mapPos(state.pos, 1),
              contextHash: state.contextHash,
              source: state.source,
            }
          }
          // Ghost text fully consumed — clear
        }
      }
      return null
    }
    // Clear ghost text when selection is explicitly set
    if (
      tr.selection &&
      !tr.effects.some(e => e.is(setGhostTextEffect))
    ) {
      return null
    }
    return state
  },
})

// ---------------------------------------------------------------------------
// WidgetType — ghost text rendering
// ---------------------------------------------------------------------------
class GhostTextWidget extends WidgetType {
  constructor(readonly text: string, readonly source: 'auto' | 'enhanced' = 'auto') {
    super()
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.source === 'enhanced'
      ? 'ol-cm-ai-ghost-text ol-cm-ai-ghost-text--enhanced'
      : 'ol-cm-ai-ghost-text'
    span.setAttribute('aria-hidden', 'true')

    // Handle multi-line: split by \n and join with <br>
    const lines = this.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        span.appendChild(document.createElement('br'))
      }
      span.appendChild(document.createTextNode(lines[i]))
    }

    return span
  }

  updateDOM(dom: HTMLElement): boolean {
    // Clear and re-render — CM6 reuses the DOM node
    dom.textContent = ''
    dom.className = this.source === 'enhanced'
      ? 'ol-cm-ai-ghost-text ol-cm-ai-ghost-text--enhanced'
      : 'ol-cm-ai-ghost-text'
    const lines = this.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        dom.appendChild(document.createElement('br'))
      }
      dom.appendChild(document.createTextNode(lines[i]))
    }
    return true
  }

  eq(other: GhostTextWidget): boolean {
    return this.text === other.text && this.source === other.source
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// Decoration field — builds decorations from ghost text state
// ---------------------------------------------------------------------------
const ghostTextDecorationField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(_, tr) {
    const ghost = tr.state.field(ghostTextField)
    if (!ghost) {
      return Decoration.none
    }
    // Validate position
    if (ghost.pos < 0 || ghost.pos > tr.state.doc.length) {
      return Decoration.none
    }
    const deco = Decoration.widget({
      widget: new GhostTextWidget(ghost.text, ghost.source),
      side: 1, // render after the position
    }).range(ghost.pos)
    return Decoration.set([deco])
  },
  provide: field => EditorView.decorations.from(field),
})

// ---------------------------------------------------------------------------
// Keymap — Tab to accept, Esc to dismiss
// ---------------------------------------------------------------------------
function acceptGhostText(view: EditorView): boolean {
  // If autocomplete dropdown is open, don't consume Tab
  if (completionStatus(view.state) !== null) return false

  const ghost = view.state.field(ghostTextField)
  if (!ghost) return false // no ghost text → pass through to other handlers

  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: clearGhostTextEffect.of(undefined),
  })
  return true // consumed
}

function dismissGhostText(view: EditorView): boolean {
  // If autocomplete dropdown is open, don't consume Esc
  if (completionStatus(view.state) !== null) return false

  const ghost = view.state.field(ghostTextField)
  if (!ghost) return false

  view.dispatch({
    effects: [
      clearGhostTextEffect.of(undefined),
      cancelAutocompleteEffect.of(undefined),
    ],
  })
  return true
}

function triggerEnhancedCompletionCmd(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  const selectedContext = from !== to
    ? view.state.sliceDoc(from, to)
    : undefined
  // Move cursor to end of selection so ghost text appears after selected text
  if (from !== to) {
    view.dispatch({ selection: { anchor: to } })
  }
  view.dispatch({
    effects: triggerEnhancedCompletionEffect.of({ selectedContext }),
  })
  return true
}

const ghostTextKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptGhostText },
    { key: 'Escape', run: dismissGhostText },
    { key: 'Alt-/', run: triggerEnhancedCompletionCmd },
  ])
)

// ---------------------------------------------------------------------------
// Utility — simple context hash for stale detection
// ---------------------------------------------------------------------------
function computeContextHash(prefix: string, suffix: string): string {
  // Use last 64 chars of prefix + first 64 chars of suffix as a fast fingerprint
  const p = prefix.slice(-64)
  const s = suffix.slice(0, 64)
  // Simple DJB2-like hash
  let hash = 5381
  const combined = p + '|' + s
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash + combined.charCodeAt(i)) | 0
  }
  return hash.toString(36)
}

// ---------------------------------------------------------------------------
// ViewPlugin — debounce, streaming fetch, LRU cache, lifecycle
// ---------------------------------------------------------------------------
const autocompletePlugin = ViewPlugin.fromClass(
  class {
    private abortController: AbortController | null = null
    private requestId = 0
    private cache = new LRUPrefixCache()
    private lastView: EditorView | null = null
    private stateMachine = new WritingStateMachine()
    private smInitialized = false

    update(update: ViewUpdate) {
      this.lastView = update.view

      if (!this.smInitialized) {
        this.smInitialized = true
        this.stateMachine.setTriggerCallback(() => {
          if (this.lastView) {
            this.requestCompletion(this.lastView, 'auto')
          }
        })
      }

      // Handle enhanced completion trigger
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(triggerEnhancedCompletionEffect)) {
            this.cancelPending(update.view)
            this.stateMachine.reset()
            this.requestCompletion(update.view, 'enhanced', effect.value.selectedContext)
            return
          }
        }
      }

      // Handle explicit cancel (e.g., Esc key)
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(cancelAutocompleteEffect)) {
            this.cancelPending(update.view)
            this.stateMachine.reset()
            return
          }
        }
      }

      if (!update.docChanged) {
        if (update.selectionSet) {
          this.stateMachine.reset()
          this.cancelPending(update.view)
        }
        return
      }

      // Check if ghost text successfully consumed the user's input.
      // Only applies when there is an ACTIVE ghost text and the user typed
      // characters matching its start (the StateField will have consumed them).
      const ghostState = update.state.field(ghostTextField, false)
      if (
        ghostState &&
        ghostState.text.length > 0 &&
        this.abortController // there's an active SSE stream to preserve
      ) {
        // Ghost text still present after doc change (user input matched its start).
        // Don't abort the SSE stream so subsequent tokens can keep appending.
        // Still let the state machine track the keystroke for state transitions,
        // but skip the pause-timer trigger (no need to fire a new request).
        return
      }

      // No ghost text or it was cleared (user input didn't match) → cancel & retrigger
      this.cancelPending(update.view)

      // State machine handles all trigger timing
      this.stateMachine.processUpdate(update)
    }

    private cancelPending(view?: EditorView) {
      if (this.abortController) {
        this.abortController.abort()
        this.abortController = null
      }
      // Always reset status to idle when cancelling
      if (view) {
        this.notifyStatus(view, 'idle')
      }
    }

    private notifyStatus(
      view: EditorView,
      status: 'idle' | 'loading' | 'streaming',
      source?: 'auto' | 'enhanced'
    ) {
      const ctx = view.state.facet(aiAutocompleteFacet)
      ctx.onStatusChange?.(status, source)
    }

    private isStale(
      view: EditorView,
      requestId: number,
      pos: number,
      contextHash: string
    ): boolean {
      if (requestId !== this.requestId) return true
      if (view.state.selection.main.head !== pos) return true
      if (!view.hasFocus) return true
      if (completionStatus(view.state) !== null) return true
      const head = view.state.selection.main.head
      const currentPrefix = view.state.doc.sliceString(
        Math.max(0, head - MAX_PREFIX_CHARS),
        head
      )
      const currentSuffix = view.state.doc.sliceString(
        head,
        Math.min(view.state.doc.length, head + MAX_SUFFIX_CHARS)
      )
      const currentHash = computeContextHash(currentPrefix, currentSuffix)
      if (currentHash !== contextHash) return true
      return false
    }

    private async requestCompletion(
      view: EditorView,
      mode: 'auto' | 'enhanced' = 'auto',
      selectedContext?: string,
    ) {
      const state = view.state
      const ctx = state.facet(aiAutocompleteFacet)

      if (!ctx.projectId) return
      if (completionStatus(state) !== null) return
      if (!view.hasFocus) return

      // Skip when multiple cursors/selections are active
      if (state.selection.ranges.length !== 1) {
        view.dispatch({ effects: clearGhostTextEffect.of(undefined) })
        return
      }

      const pos = state.selection.main.head

      const prefixChars = mode === 'enhanced' ? ENHANCED_MAX_PREFIX_CHARS : MAX_PREFIX_CHARS
      const suffixChars = mode === 'enhanced' ? ENHANCED_MAX_SUFFIX_CHARS : MAX_SUFFIX_CHARS

      // Only slice the range we actually need instead of the full document
      const prefixStart = Math.max(0, pos - prefixChars)
      const suffixEnd = Math.min(state.doc.length, pos + suffixChars)
      const prefix = state.doc.sliceString(prefixStart, pos)
      const suffix = state.doc.sliceString(pos, suffixEnd)

      const cursorLine = state.doc.lineAt(pos).number
      const documentCharCount = state.doc.length
      const recentEdits = this.stateMachine.getRecentEditTexts(state.doc)

      // Check minimum prefix length (use actual distance from doc start for short docs)
      if (pos < MIN_PREFIX_LENGTH) return
      const contextHash = computeContextHash(prefix, suffix)

      // Check LRU cache first (only for auto mode)
      if (mode !== 'enhanced') {
        const cached = this.cache.lookup(prefix, suffix, contextHash)
        if (cached && cached.trim().length > 0) {
          view.dispatch({
            effects: setGhostTextEffect.of({
              text: cached,
              pos,
              contextHash,
              source: mode,
            }),
          })
          return
        }
      }

      const currentRequestId = ++this.requestId

      this.abortController = new AbortController()
      const signal = this.abortController.signal

      this.notifyStatus(view, 'loading', mode)

      try {
        let accumulated = ''
        let firstChunkTime = 0
        let lastUpdateTime = 0
        let shownInitial = false

        for await (const event of fetchCompletionStream(
          {
            projectId: ctx.projectId,
            prefix,
            suffix,
            fileName: ctx.fileName,
            cursorLine,
            documentCharCount,
            recentEdits: recentEdits.length > 0 ? recentEdits : undefined,
            mode,
            selectedContext,
          },
          signal
        )) {
          if (this.isStale(view, currentRequestId, pos, contextHash)) {
            this.abortController?.abort()
            this.abortController = null
            this.notifyStatus(view, 'idle', mode)
            return
          }

          if (event.type === 'text' && event.content) {
            if (!firstChunkTime) {
              firstChunkTime = Date.now()
              this.notifyStatus(view, 'streaming', mode)
            }
            accumulated += event.content
            // Hard-truncate streaming accumulation
            if (accumulated.length > MAX_GHOST_TEXT_CHARS) {
              accumulated = accumulated.slice(0, MAX_GHOST_TEXT_CHARS)
            }

            const now = Date.now()
            // Initial delay: don't show until INITIAL_DELAY ms after first chunk
            if (!shownInitial) {
              if (now - firstChunkTime >= INITIAL_DELAY) {
                shownInitial = true
                lastUpdateTime = now
                view.dispatch({
                  effects: setGhostTextEffect.of({
                    text: accumulated,
                    pos,
                    contextHash,
                    source: mode,
                  }),
                })
              }
              continue
            }

            // Throttle updates
            if (now - lastUpdateTime >= STREAM_UPDATE_INTERVAL) {
              lastUpdateTime = now
              view.dispatch({
                effects: setGhostTextEffect.of({
                  text: accumulated,
                  pos,
                  contextHash,
                  source: mode,
                }),
              })
            }
          }

          if (event.type === 'done') {
            // Use the server's cleaned completion if available
            let finalCompletion = event.completion || accumulated
            // Hard-truncate to prevent excessively long ghost text
            if (finalCompletion.length > MAX_GHOST_TEXT_CHARS) {
              finalCompletion = finalCompletion.slice(0, MAX_GHOST_TEXT_CHARS)
            }
            if (finalCompletion && finalCompletion.trim().length > 0) {
              shownInitial = true // Mark as handled to skip fallback
              view.dispatch({
                effects: setGhostTextEffect.of({
                  text: finalCompletion,
                  pos,
                  contextHash,
                  source: mode,
                }),
              })
              // Write to cache
              this.cache.set(prefix, {
                completion: finalCompletion,
                prefix,
                suffix,
                contextHash,
              })
            }
            break
          }

          if (event.type === 'error') {
            break
          }
        }

        // If we accumulated text but no 'done' event with completion, show what we have
        if (accumulated && accumulated.trim().length > 0 && !shownInitial) {
          view.dispatch({
            effects: setGhostTextEffect.of({
              text: accumulated,
              pos,
              contextHash,
              source: mode,
            }),
          })
          this.cache.set(prefix, {
            completion: accumulated,
            prefix,
            suffix,
            contextHash,
          })
        }

        this.abortController = null
        this.notifyStatus(view, 'idle', mode)
      } catch {
        this.abortController = null
        this.notifyStatus(view, 'idle', mode)
      }
    }

    destroy() {
      this.stateMachine.destroy()
      this.cancelPending(this.lastView ?? undefined)
    }
  }
)

// ---------------------------------------------------------------------------
// Theme — ghost text appearance
// ---------------------------------------------------------------------------
const ghostTextTheme = EditorView.baseTheme({
  // Base styles for ghost text (shared across dark/light)
  '.ol-cm-ai-ghost-text': {
    fontStyle: 'italic',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
  },
  // Dark themes: white at 45% opacity → contrast ~4.2:1 on typical dark backgrounds
  '&dark .ol-cm-ai-ghost-text': {
    color: 'rgba(255, 255, 255, 0.45)',
  },
  // Light themes: black at 45% opacity → contrast ~3.4:1 on typical light backgrounds
  '&light .ol-cm-ai-ghost-text': {
    color: 'rgba(0, 0, 0, 0.45)',
  },
})

// ---------------------------------------------------------------------------
// Compartment — dynamic enable/disable
// ---------------------------------------------------------------------------
const aiAutocompleteConf = new Compartment()

function buildExtensions(options: AutocompleteContext): Extension[] {
  return [
    aiAutocompleteFacet.of(options),
    ghostTextField,
    ghostTextDecorationField,
    ghostTextKeymap,
    autocompletePlugin,
    ghostTextTheme,
  ]
}

export function aiAutocomplete(
  options: AutocompleteContext = {
    projectId: '',
    fileName: '',
    onStatusChange: undefined,
  }
): Extension {
  return aiAutocompleteConf.of(buildExtensions(options))
}

export function setAIAutocomplete(options: {
  enabled: boolean
  projectId: string
  fileName: string
  onStatusChange?: (status: 'idle' | 'loading' | 'streaming', source?: 'auto' | 'enhanced') => void
}): TransactionSpec {
  if (!options.enabled) {
    return { effects: aiAutocompleteConf.reconfigure([]) }
  }
  return {
    effects: aiAutocompleteConf.reconfigure(
      buildExtensions({
        projectId: options.projectId,
        fileName: options.fileName,
        onStatusChange: options.onStatusChange,
      })
    ),
  }
}

export function triggerEnhancedCompletion(view: EditorView, selectedContext?: string) {
  view.dispatch({
    effects: triggerEnhancedCompletionEffect.of({ selectedContext }),
  })
}
