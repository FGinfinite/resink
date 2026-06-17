import OError from '@overleaf/o-error'

export class ToolError extends OError {}
export class ToolExecutionError extends ToolError {}
export class ToolValidationError extends ToolError {}

/**
 * Base class for all tools
 * Tools are functions that the AI can call to interact with the system
 */
export class Tool {
  /**
   * @param {object} options
   * @param {string} options.name - Tool name (used in function calling)
   * @param {string} options.description - Description for the LLM
   * @param {z.ZodSchema} options.parameters - Zod schema for parameters
   */
  constructor(options) {
    this.name = options.name
    this.description = options.description
    this.parameters = options.parameters
  }

  /**
   * Execute the tool
   * @param {object} args - Validated arguments
   * @param {object} context - Execution context
   * @param {string} context.sessionId - Session ID
   * @param {string} context.projectId - Project ID
   * @param {object} context.adapters - Adapter instances
   * @returns {Promise<ToolResult>}
   */
  async execute(_args, _context) {
    throw new Error('execute() must be implemented by subclass')
  }

  /**
   * Validate arguments against schema
   * @param {object} args - Arguments to validate
   * @returns {object} - Validated arguments
   * @throws {ToolValidationError}
   */
  validateArgs(args) {
    const result = this.parameters.safeParse(args)
    if (!result.success) {
      throw new ToolValidationError('Invalid tool arguments', {
        errors: result.error.errors,
      })
    }
    return result.data
  }

  /**
   * Convert to OpenAI function calling format
   * @returns {object}
   */
  toOpenAIFormat() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: zodToJsonSchema(this.parameters),
      },
    }
  }
}

/**
 * Result from tool execution
 */
export class ToolResult {
  /**
   * @param {object} options
   * @param {boolean} options.success - Whether execution succeeded
   * @param {string} options.output - Output text for the LLM
   * @param {object} [options.data] - Structured data (e.g., pendingChange)
   * @param {string} [options.error] - Error message if failed
   */
  constructor(options) {
    this.success = options.success
    this.output = options.output
    this.data = options.data || null
    this.error = options.error || null
  }

  static success(output, data = null) {
    return new ToolResult({ success: true, output, data })
  }

  static error(message, data = null) {
    return new ToolResult({ success: false, output: message, error: message, data })
  }

  toJSON() {
    return {
      success: this.success,
      output: this.output,
      data: this.data,
      error: this.error,
    }
  }
}

/**
 * Convert Zod schema to JSON Schema format
 * This is a simplified converter - only handles common types
 */
function zodToJsonSchema(schema) {
  const jsonSchema = { type: 'object', properties: {}, required: [] }

  if (schema._def.typeName === 'ZodObject') {
    const shape = schema._def.shape()

    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = zodFieldToJsonSchema(value)
      jsonSchema.properties[key] = fieldSchema

      // Check if field is required
      if (!value.isOptional()) {
        jsonSchema.required.push(key)
      }
    }
  }

  return jsonSchema
}

function zodFieldToJsonSchema(field) {
  const def = field._def

  // Handle optional wrapper
  if (def.typeName === 'ZodOptional') {
    return zodFieldToJsonSchema(def.innerType)
  }

  // Handle nullable
  if (def.typeName === 'ZodNullable') {
    return zodFieldToJsonSchema(def.innerType)
  }

  // Handle default
  if (def.typeName === 'ZodDefault') {
    return zodFieldToJsonSchema(def.innerType)
  }

  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string', description: def.description }

    case 'ZodNumber':
      return { type: 'number', description: def.description }

    case 'ZodBoolean':
      return { type: 'boolean', description: def.description }

    case 'ZodArray':
      return {
        type: 'array',
        items: zodFieldToJsonSchema(def.type),
        description: def.description,
      }

    case 'ZodEnum':
      return {
        type: 'string',
        enum: def.values,
        description: def.description,
      }

    case 'ZodObject':
      return zodToJsonSchema(field)

    default:
      return { type: 'string' }
  }
}

export default Tool
