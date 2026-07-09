import { describe, expect, it } from 'vitest'
import { AgentRuntimeAdapter, AgentRuntimeEventTypes } from '../../../../app/js/runtime/AgentRuntimeAdapter.js'
import { RuntimeErrorCodes } from '../../../../app/js/runtime/RuntimeErrors.js'

class TestRuntimeAdapter extends AgentRuntimeAdapter {
  constructor() {
    super({ id: 'test', displayName: 'Test Runtime' })
  }
}

describe('AgentRuntimeAdapter', () => {
  it('requires adapter identity', () => {
    expect(() => new AgentRuntimeAdapter()).toThrow(/id is required/)
  })

  it('validates required run input', () => {
    const adapter = new TestRuntimeAdapter()

    expect(() => adapter.requirePrompt({})).toThrow(/prompt is required/)
    expect(() => adapter.requireSandboxSession({})).toThrow(/sandboxSession is required/)
    expect(() => adapter.requireSandboxSession({ sandboxSession: {} })).toThrow(/sandboxSession.run/)
  })

  it('normalizes sandbox process events into runtime events', () => {
    const adapter = new TestRuntimeAdapter()

    expect(adapter.normalizeEvent({ type: 'stdout', content: 'hello' })).toEqual({
      type: AgentRuntimeEventTypes.TEXT,
      stream: 'stdout',
      content: 'hello',
    })
    expect(adapter.normalizeEvent({ type: 'stderr', content: 'warn' })).toEqual({
      type: AgentRuntimeEventTypes.LOG,
      level: 'warn',
      stream: 'stderr',
      content: 'warn',
    })
    expect(adapter.normalizeEvent({ type: 'exit', exitCode: 0 })).toEqual({
      type: AgentRuntimeEventTypes.DONE,
      exitCode: 0,
    })
  })

  it('exports stable runtime error codes', () => {
    expect(RuntimeErrorCodes).toMatchObject({
      MISSING_BINARY: 'MISSING_BINARY',
      AUTH_FAILURE: 'AUTH_FAILURE',
      EXECUTION_FAILURE: 'EXECUTION_FAILURE',
    })
  })
})
