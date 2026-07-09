import logger from '@overleaf/logger'
import { ToolError } from './Tool.js'

/**
 * Registry for managing available tools
 */
export class ToolRegistry {
  constructor() {
    this.tools = new Map()
  }

  /**
   * Register a tool
   * @param {Tool} tool - Tool instance to register
   * @throws {ToolError} If tool with same name already exists
   */
  register(tool) {
    if (this.tools.has(tool.name)) {
      throw new ToolError(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
    logger.debug({ toolName: tool.name }, 'Tool registered')
  }

  /**
   * Register multiple tools
   * @param {Tool[]} tools - Array of tools to register
   */
  registerAll(tools) {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /**
   * Get a tool by name
   * @param {string} name - Tool name
   * @returns {Tool|undefined}
   */
  get(name) {
    return this.tools.get(name)
  }

  /**
   * Check if a tool exists
   * @param {string} name - Tool name
   * @returns {boolean}
   */
  has(name) {
    return this.tools.has(name)
  }

  /**
   * Get all registered tools
   * @returns {Tool[]}
   */
  getAll() {
    return Array.from(this.tools.values())
  }

  /**
   * Get all tool names
   * @returns {string[]}
   */
  getNames() {
    return Array.from(this.tools.keys())
  }

  /**
   * Get tools in OpenAI function calling format
   * @returns {Array<object>}
   */
  getTools() {
    return this.getAll().map(tool => tool.toOpenAIFormat())
  }

  /**
   * Create a read-only registry view containing only allowed tool names.
   * @param {Iterable<string>} allowedNames - Tool names allowed by profile/policy
   * @returns {ScopedToolRegistry}
   */
  scoped(allowedNames) {
    return new ScopedToolRegistry(this, allowedNames)
  }

  /**
   * Unregister a tool
   * @param {string} name - Tool name
   * @returns {boolean} - Whether the tool was removed
   */
  unregister(name) {
    return this.tools.delete(name)
  }

  /**
   * Clear all registered tools
   */
  clear() {
    this.tools.clear()
  }

  /**
   * Get the number of registered tools
   * @returns {number}
   */
  get size() {
    return this.tools.size
  }
}

export class ScopedToolRegistry {
  constructor(parent, allowedNames) {
    this.parent = parent
    this.allowedNames = new Set(allowedNames || [])
  }

  get(name) {
    if (!this.allowedNames.has(name)) return undefined
    return this.parent.get(name)
  }

  has(name) {
    return this.allowedNames.has(name) && this.parent.has(name)
  }

  getAll() {
    return this.getNames()
      .map(name => this.parent.get(name))
      .filter(Boolean)
  }

  getNames() {
    return this.parent.getNames().filter(name => this.allowedNames.has(name))
  }

  getTools() {
    return this.getAll().map(tool => tool.toOpenAIFormat())
  }

  get size() {
    return this.getAll().length
  }
}

// Default registry instance
let defaultRegistry = null

export function getToolRegistry() {
  if (!defaultRegistry) {
    defaultRegistry = new ToolRegistry()
  }
  return defaultRegistry
}

export function createToolRegistry() {
  return new ToolRegistry()
}

export default ToolRegistry
