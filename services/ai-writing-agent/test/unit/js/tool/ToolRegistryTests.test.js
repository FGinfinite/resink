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
