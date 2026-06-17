import logger from '@overleaf/logger'
import passport from 'passport'
import GitHubOAuthController from './GitHubOAuthController.mjs'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'

export default {
  applyNonCsrfRouter(webRouter) {
    logger.debug({}, 'Init GitHub OAuth router (non-CSRF)')

    // Whitelist OAuth endpoints so unauthenticated users can access them
    AuthenticationController.addEndpointToLoginWhitelist('/auth/github')
    AuthenticationController.addEndpointToLoginWhitelist(
      '/auth/github/callback'
    )

    // Initiate GitHub OAuth flow
    webRouter.get(
      '/auth/github',
      passport.authenticate('github', { scope: ['user:email'] })
    )

    // Handle GitHub OAuth callback
    webRouter.get(
      '/auth/github/callback',
      (req, res, next) => {
        passport.authenticate('github', { session: false }, (err, data) => {
          if (err) {
            logger.error({ err }, 'GitHub OAuth authentication error')
            return res.redirect('/login?error=github_error')
          }
          if (!data) {
            return res.redirect('/login?error=github_denied')
          }
          req.gitHubOAuth = data
          next()
        })(req, res, next)
      },
      GitHubOAuthController.handleGitHubCallback
    )
  },
}
