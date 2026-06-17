import logger from '@overleaf/logger'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import UserCreator from '../../../../app/src/Features/User/UserCreator.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import ThirdPartyIdentityManager from '../../../../app/src/Features/User/ThirdPartyIdentityManager.mjs'
import Errors from '../../../../app/src/Features/Errors/Errors.js'

const PROVIDER_ID = 'github'

function _isAlreadyLinked(user, githubId) {
  return (
    user.thirdPartyIdentifiers &&
    user.thirdPartyIdentifiers.some(
      tpi =>
        tpi.providerId === PROVIDER_ID &&
        String(tpi.externalUserId) === githubId
    )
  )
}

async function handleGitHubCallback(req, res, next) {
  const { githubUser } = req.gitHubOAuth || {}
  if (!githubUser) {
    logger.warn({}, 'GitHub OAuth callback missing data')
    return res.redirect('/login')
  }

  try {
    const githubId = String(githubUser.id)
    const email = (githubUser._verifiedEmail || '').toLowerCase()

    if (!email) {
      logger.warn({ githubId }, 'GitHub account has no verified primary email')
      return res.redirect('/login?error=github_no_verified_email')
    }

    // Try to find user by GitHub identity (already linked)
    let user = null
    let alreadyLinked = false
    try {
      user = await ThirdPartyIdentityManager.promises.getUser(
        PROVIDER_ID,
        githubId
      )
      alreadyLinked = true
    } catch (err) {
      if (!(err instanceof Errors.ThirdPartyUserNotFoundError)) {
        throw err
      }
    }

    // If not found by GitHub ID, try by confirmed email
    if (!user) {
      const users =
        await UserGetter.promises.getUsersByAnyConfirmedEmail([email])
      user = users.length > 0 ? users[0] : null
    }

    const externalData = {
      login: githubUser.login,
      name: githubUser.name,
      email,
    }

    if (user) {
      if (!alreadyLinked && !_isAlreadyLinked(user, githubId)) {
        // Link GitHub identity to existing user
        try {
          await ThirdPartyIdentityManager.promises.link(
            user._id,
            PROVIDER_ID,
            githubId,
            externalData,
            {
              initiatorId: user._id,
              ipAddress: req.ip,
            }
          )
        } catch (err) {
          if (err instanceof Errors.ThirdPartyIdentityExistsError) {
            logger.warn(
              { githubId, userId: user._id },
              'GitHub identity already linked to another account'
            )
            return res.redirect('/login?error=github_already_linked')
          }
          throw err
        }
      }
    } else {
      // Create new user
      const nameParts = (githubUser.name || githubUser.login || '').split(' ')
      user = await UserCreator.promises.createNewUser({
        email,
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        holdingAccount: false,
      })

      await ThirdPartyIdentityManager.promises.link(
        user._id,
        PROVIDER_ID,
        githubId,
        externalData,
        {
          initiatorId: user._id,
          ipAddress: req.ip,
        }
      )
    }

    // Log the user in
    AuthenticationController.setAuditInfo(req, {
      method: 'GitHub SSO',
      provider: PROVIDER_ID,
    })
    await AuthenticationController.promises.finishLogin(user, req, res)
  } catch (err) {
    logger.error({ err }, 'GitHub OAuth login failed')
    return res.redirect('/login?error=github_error')
  }
}

export default {
  handleGitHubCallback,
}
