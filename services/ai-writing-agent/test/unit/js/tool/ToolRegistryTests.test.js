import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

// Mock @overleaf/logger
vi.mock('@overleaf/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    log: vi.fn(),
  },
}))

// Mock @overleaf/o-error
vi.mock('@overleaf/o-error', () => {
  class OError extends Error {
    constructor(message, info) {
      super(message)
      this.name = this.constructor.name
      this.info = info
    }
  }
  return { default: OError }
})

const { Tool, ToolResult, ToolValidationError } = await import(
  '../../../../app/js/tool/Tool.js'
)
const { ToolRegistry } = await import(
  '../../../../app/js/tool/ToolRegistry.js'
)
const { ToolsetPolicy } = await import(
  '../../../../app/js/tool/ToolsetPolicy.js'
)

// Create a concrete test tool subclass
class TestTool extends Tool {
  constructor(name = 'test_tool', description = 'A test tool') {
    super({
      name,
      description,
      parameters: z.object({
        input: z.string().describe('Input text'),
        count: z.number().optional().describe('Optional count'),
      }),
    })
  }

  async execute(args, _context) {
    return ToolResult.success(`Executed with input: ${args.input}`)
  }
}

describe('ToolRegistry', () => {
  let registry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  describe('register', () => {
    it('adds tool', () => {
      const tool = new TestTool()
      registry.register(tool)

      expect(registry.has('test_tool')).toBe(true)
    })

    it('throws on duplicate name', () => {
      const tool1 = new TestTool('dup_tool')
      const tool2 = new TestTool('dup_tool')

      registry.register(tool1)

      expect(() => registry.register(tool2)).toThrow('Tool already registered: dup_tool')
    })
  })

  describe('get', () => {
    it('returns registered tool', () => {
      const tool = new TestTool()
      registry.register(tool)

      const retrieved = registry.get('test_tool')
      expect(retrieved).toBe(tool)
    })

    it('returns undefined for unknown tool', () => {
      const result = registry.get('nonexistent_tool')
      expect(result).toBeUndefined()
    })
  })

  describe('has', () => {
    it('returns true for registered tool', () => {
      registry.register(new TestTool())
      expect(registry.has('test_tool')).toBe(true)
    })

    it('returns false for unregistered tool', () => {
      expect(registry.has('test_tool')).toBe(false)
    })
  })

  describe('getAll', () => {
    it('returns all tools', () => {
      const tool1 = new TestTool('tool_a', 'Tool A')
      const tool2 = new TestTool('tool_b', 'Tool B')
      registry.register(tool1)
      registry.register(tool2)

      const all = registry.getAll()
      expect(all).toHaveLength(2)
      expect(all).toContain(tool1)
      expect(all).toContain(tool2)
    })

    it('returns empty array when no tools registered', () => {
      expect(registry.getAll()).toEqual([])
    })
  })

  describe('getTools', () => {
    it('returns OpenAI format array', () => {
      registry.register(new TestTool('my_tool', 'My tool description'))

      const tools = registry.getTools()

      expect(tools).toHaveLength(1)
      expect(tools[0].type).toBe('function')
      expect(tools[0].function.name).toBe('my_tool')
      expect(tools[0].function.description).toBe('My tool description')
      expect(tools[0].function.parameters).toBeDefined()
      expect(tools[0].function.parameters.type).toBe('object')
      expect(tools[0].function.parameters.properties.input).toBeDefined()
    })
  })

  describe('scoped', () => {
    it('exposes only tools allowed by policy', () => {
      const readTool = new TestTool('read_document', 'Read document')
      const editTool = new TestTool('edit_document', 'Edit document')
      registry.register(readTool)
      registry.register(editTool)

      const scoped = registry.scoped(['read_document'])

      expect(scoped.has('read_document')).toBe(true)
      expect(scoped.has('edit_document')).toBe(false)
      expect(scoped.get('read_document')).toBe(readTool)
      expect(scoped.get('edit_document')).toBeUndefined()
      expect(scoped.getNames()).toEqual(['read_document'])
      expect(scoped.getTools().map(tool => tool.function.name)).toEqual(['read_document'])
      expect(scoped.size).toBe(1)
    })

    it('ignores allowed names that are not registered', () => {
      registry.register(new TestTool('read_document', 'Read document'))

      const scoped = registry.scoped(['read_document', 'missing_tool'])

      expect(scoped.getNames()).toEqual(['read_document'])
      expect(scoped.getAll()).toHaveLength(1)
    })
  })

  describe('unregister', () => {
    it('removes tool', () => {
      registry.register(new TestTool())
      expect(registry.has('test_tool')).toBe(true)

      const removed = registry.unregister('test_tool')
      expect(removed).toBe(true)
      expect(registry.has('test_tool')).toBe(false)
    })

    it('returns false for non-existent tool', () => {
      const removed = registry.unregister('nonexistent')
      expect(removed).toBe(false)
    })
  })

  describe('clear', () => {
    it('removes all tools', () => {
      registry.register(new TestTool('tool_a'))
      registry.register(new TestTool('tool_b'))
      expect(registry.size).toBe(2)

      registry.clear()

      expect(registry.size).toBe(0)
      expect(registry.getAll()).toEqual([])
    })
  })

  describe('size', () => {
    it('returns correct count', () => {
      expect(registry.size).toBe(0)

      registry.register(new TestTool('t1'))
      expect(registry.size).toBe(1)

      registry.register(new TestTool('t2'))
      expect(registry.size).toBe(2)

      registry.unregister('t1')
      expect(registry.size).toBe(1)
    })
  })
})

describe('ToolsetPolicy', () => {
  it('maps profiles to model-visible tool names', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({ profile: 'citation-assistant' })

    expect(resolved.profile).toBe('citation-assistant')
    expect(resolved.toolsets).toEqual(['project-read', 'citation'])
    expect(resolved.tools).toEqual([
      'list_files',
      'read_document',
      'search_project',
      'view_file',
      'doc_structure_map',
      'bib_lookup',
      'bib_manage',
    ])
  })

  it('falls back to default for unknown profiles', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({ profile: 'unknown-profile' })

    expect(resolved.profile).toBe('default')
    expect(resolved.tools).toContain('edit_document')
    expect(resolved.tools).toContain('sync_workspace_changes')
    expect(resolved.tools).toContain('compile_latex')
    expect(resolved.tools).toContain('run_command')
    expect(resolved.tools).toContain('write_workspace_file')
    expect(resolved.tools).toContain('read_skill_reference')
    expect(resolved.tools).toContain('run_skill_script')
    expect(resolved.tools).toContain('start_agent_task')
    expect(resolved.tools).toContain('start_agent_team')
    expect(resolved.tools).toContain('handoff_to_agent')
    expect(resolved.tools).toContain('return_from_handoff')
    expect(resolved.tools).not.toContain('delegate_task')
    expect(resolved.tools).toContain('inspect_python_environment')
    expect(resolved.tools).toContain('propose_memory')
  })

  it('exposes structured agent team tools instead of legacy delegate tool', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({ profile: 'default' })

    expect(resolved.toolsets).toContain('subagent')
    expect(resolved.tools).toContain('start_agent_task')
    expect(resolved.tools).toContain('start_agent_team')
    expect(resolved.tools).toContain('handoff_to_agent')
    expect(resolved.tools).toContain('return_from_handoff')
    expect(resolved.tools).not.toContain('delegate_task')
  })

  it('narrows profile toolsets with user/project policy', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({
      profile: 'default',
      policy: {
        allowWrite: false,
        allowSubagents: false,
        allowHandoff: false,
        allowDiagnostics: false,
      },
    })

    expect(resolved.tools).not.toContain('edit_document')
    expect(resolved.tools).not.toContain('delete_file')
    expect(resolved.tools).not.toContain('start_agent_task')
    expect(resolved.tools).not.toContain('start_agent_team')
    expect(resolved.tools).not.toContain('handoff_to_agent')
    expect(resolved.tools).not.toContain('return_from_handoff')
    expect(resolved.tools).not.toContain('delegate_task')
    expect(resolved.tools).not.toContain('activate_skill')
    expect(resolved.tools).not.toContain('inspect_python_environment')
    expect(resolved.tools).toContain('propose_memory')
    expect(resolved.tools).toContain('run_command')
    expect(resolved.tools).toContain('write_workspace_file')
    expect(resolved.tools).toContain('sync_workspace_changes')
    expect(resolved.tools).toContain('read_document')
    expect(resolved.tools).toContain('bib_lookup')
  })


  it('keeps exec tools in default profile and out of read-only profiles', () => {
    const policy = new ToolsetPolicy()

    const defaults = policy.resolve({ profile: 'default' })
    const readOnly = policy.resolve({ profile: 'read-only' })
    const auditor = policy.resolve({ profile: 'document-auditor' })

    expect(defaults.toolsets).toContain('exec')
    expect(defaults.tools).toContain('run_command')
    expect(defaults.tools).toContain('write_workspace_file')
    expect(defaults.tools).toContain('sync_workspace_changes')
    expect(defaults.tools).toContain('read_skill_reference')
    expect(defaults.tools).toContain('run_skill_script')
    expect(readOnly.tools).not.toContain('run_command')
    expect(readOnly.tools).not.toContain('write_workspace_file')
    expect(auditor.tools).not.toContain('run_command')
    expect(auditor.tools).not.toContain('write_workspace_file')
  })

  it('supports disabling exec tools with policy', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({
      profile: 'default',
      policy: { allowExec: false },
    })

    expect(resolved.toolsets).not.toContain('exec')
    expect(resolved.tools).not.toContain('run_command')
    expect(resolved.tools).not.toContain('write_workspace_file')
    expect(resolved.tools).toContain('compile_latex')
  })


  it('supports disabling workspace sync tools with policy', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({
      profile: 'default',
      policy: { allowWorkspaceSync: false },
    })

    expect(resolved.toolsets).not.toContain('workspace-sync')
    expect(resolved.tools).not.toContain('sync_workspace_changes')
    expect(resolved.tools).toContain('edit_document')
  })


  it('supports disabling skill runtime tools with policy', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({
      profile: 'default',
      policy: { allowSkillRuntime: false },
    })

    expect(resolved.toolsets).not.toContain('skill-runtime')
    expect(resolved.tools).not.toContain('read_skill_reference')
    expect(resolved.tools).not.toContain('run_skill_script')
    expect(resolved.tools).toContain('activate_skill')
    expect(resolved.tools).toContain('inspect_python_environment')
  })

  it('supports explicit allow and deny tool name narrowing', () => {
    const policy = new ToolsetPolicy()

    const resolved = policy.resolve({
      profile: 'default',
      allowedToolNames: ['read_document', 'edit_document', 'delegate_task'],
      deniedToolNames: ['delegate_task'],
    })

    expect(resolved.tools).toEqual(['read_document', 'edit_document'])
  })

  it('supports disabling memory proposal tools for child agents', () => {
    const policy = new ToolsetPolicy()

    const root = policy.resolve({
      profile: 'default',
      policy: { allowMemoryProposals: true },
    })
    const child = policy.resolve({
      profile: 'default',
      policy: { allowMemoryProposals: false },
    })

    expect(root.toolsets).toContain('memory')
    expect(root.tools).toContain('propose_memory')
    expect(child.toolsets).not.toContain('memory')
    expect(child.tools).not.toContain('propose_memory')
  })
})

describe('Tool', () => {
  describe('toOpenAIFormat', () => {
    it('generates correct format with name, description, parameters', () => {
      const tool = new TestTool('format_tool', 'Format tool description')

      const format = tool.toOpenAIFormat()

      expect(format.type).toBe('function')
      expect(format.function.name).toBe('format_tool')
      expect(format.function.description).toBe('Format tool description')
      expect(format.function.parameters.type).toBe('object')
      expect(format.function.parameters.properties.input).toBeDefined()
      expect(format.function.parameters.properties.input.type).toBe('string')
      expect(format.function.parameters.required).toContain('input')
    })
  })

  describe('validateArgs', () => {
    it('validates with zod schema and returns parsed data', () => {
      const tool = new TestTool()

      const result = tool.validateArgs({ input: 'hello', count: 5 })

      expect(result.input).toBe('hello')
      expect(result.count).toBe(5)
    })

    it('validates required fields only', () => {
      const tool = new TestTool()

      const result = tool.validateArgs({ input: 'hello' })

      expect(result.input).toBe('hello')
      expect(result.count).toBeUndefined()
    })

    it('throws ToolValidationError on invalid args', () => {
      const tool = new TestTool()

      // Missing required 'input' field
      expect(() => tool.validateArgs({})).toThrow(ToolValidationError)
    })

    it('throws ToolValidationError on wrong type', () => {
      const tool = new TestTool()

      // 'count' should be a number, not a string
      expect(() =>
        tool.validateArgs({ input: 'hello', count: 'not-a-number' })
      ).toThrow(ToolValidationError)
    })
  })
})
