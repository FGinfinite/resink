import { z } from 'zod'

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid ObjectId')

export const sessionIdSchema = objectIdSchema

export const projectIdSchema = objectIdSchema

export const docIdSchema = objectIdSchema

export const changeIdSchema = objectIdSchema

export function validateObjectId(id, fieldName = 'id') {
  const result = objectIdSchema.safeParse(id)
  if (!result.success) {
    const error = new Error(`Invalid ${fieldName}`)
    error.status = 400
    error.code = 'INVALID_ID'
    throw error
  }
  return result.data
}

export function validateRequest(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      const error = new Error('Validation error')
      error.status = 400
      error.code = 'VALIDATION_ERROR'
      error.details = result.error.errors
      return next(error)
    }
    req.validatedBody = result.data
    next()
  }
}
