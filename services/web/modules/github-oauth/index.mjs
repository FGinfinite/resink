import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import { Strategy as OAuth2Strategy } from 'passport-oauth2'
import fetch from 'node-fetch'
import GitHubOAuthRouter from './app/src/GitHubOAuthRouter.mjs'

/**
 * fetch wrapper with AbortController-based timeout.
 * @param {string} url
 * @param {object} options - node-fetch options
 * @param {number} [timeoutMs=5000] - timeout in milliseconds
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = Settings.githubOAuth?.requestTimeoutMs || 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @import { WebModule } from "../../types/web-module"
 */

/** @type {WebModule} */
const GitHubOAuthModule = {
  router: GitHubOAuthRouter,

  hooks: {
    passportSetup(passport, callback) {
      const config = Settings.githubOAuth
      if (!config) {
        logger.debug({}, 'GitHub OAuth not configured, skipping passport setup')
        return callback()
      }

      const strategy = new OAuth2Strategy(
        {
          authorizationURL: Settings.githubOAuth?.authorizationURL || 'https://github.com/login/oauth/authorize',
          tokenURL: Settings.githubOAuth?.tokenURL || 'https://github.com/login/oauth/access_token',
          clientID: config.clientId,
          clientSecret: config.clientSecret,
          callbackURL: config.callbackUrl,
          scope: ['user:email'],
          state: true, // Enable OAuth state parameter for CSRF protection
        },
        (accessToken, refreshToken, profile, done) => {
          const headers = {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'User-Agent': Settings.githubOAuth?.userAgent || 'ResInk-AI',
          }
          Promise.all([
            fetchWithTimeout(Settings.githubOAuth?.apiUserURL || 'https://api.github.com/user', { headers }).then(res => {
              if (!res.ok) throw new Error(`GitHub API /user failed: ${res.status}`)
              return res.json()
            }),
            fetchWithTimeout(Settings.githubOAuth?.apiUserEmailsURL || 'https://api.github.com/user/emails', { headers }).then(res => {
              if (!res.ok) throw new Error(`GitHub API /user/emails failed: ${res.status}`)
              return res.json()
            }),
          ])
            .then(([githubUser, emails]) => {
              const primaryVerified = emails.find(e => e.primary && e.verified)
              githubUser._verifiedEmail = primaryVerified ? primaryVerified.email : null
              done(null, { githubUser })
            })
            .catch(err => {
              logger.error({ err }, 'Failed to fetch GitHub user info')
              done(err)
            })
        }
      )

      strategy.name = 'github'
      passport.use(strategy)
      logger.info({}, 'GitHub OAuth passport strategy registered')
      callback()
    },
  },
}

export default GitHubOAuthModule
