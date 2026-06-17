import { db } from '../../../app/src/infrastructure/mongodb.mjs'
import UserRegistrationHandler from '../../../app/src/Features/User/UserRegistrationHandler.mjs'
import UserGetter from '../../../app/src/Features/User/UserGetter.mjs'
import settings from '@overleaf/settings'
import logger from '@overleaf/logger'

/**
 * Auto-create admin user on first startup (one-time, idempotent).
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from environment via settings.
 * Skips if already configured, user already exists, or on error.
 */
export default async function main() {
  const { email, password } = settings.autoCreateAdmin || {}

  if (!email || !password) {
    logger.debug(
      'auto-create-admin: ADMIN_EMAIL or ADMIN_PASSWORD not set, skipping'
    )
    return
  }

  try {
    const existingUser = await UserGetter.promises.getUserByAnyEmail(email)
    if (existingUser) {
      logger.info(
        { email },
        'auto-create-admin: admin user already exists, skipping'
      )
      return
    }

    const user = await UserRegistrationHandler.promises.registerNewUser({
      email,
      password,
    })

    await db.users.updateOne(
      { _id: user._id },
      { $set: { isAdmin: true } }
    )

    logger.info(
      { email, userId: user._id },
      'auto-create-admin: admin user created'
    )
  } catch (error) {
    logger.error(
      { err: error, email },
      'auto-create-admin: failed to create admin user'
    )
    // Do not crash the process
  }
}
