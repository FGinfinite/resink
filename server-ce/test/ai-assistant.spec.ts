import { createProjectAndOpenInNewEditor, openProjectById } from './helpers/project'
import { isExcludedBySharding, startWith } from './helpers/config'
import { ensureUserExists, login } from './helpers/login'
import { v4 as uuid } from 'uuid'
import { beforeWithReRunOnTestRetry } from './helpers/beforeWithReRunOnTestRetry'

const USER = 'user@example.com'

describe('ai-assistant', function () {
  // Use a dedicated shard for AI tests
  if (isExcludedBySharding('CE_CUSTOM_1')) return

  startWith({
    vars: {
      OVERLEAF_ENABLE_AI_ASSISTANT: 'true',
      AI_ASSISTANT_URL: 'http://mock-ai:3060/api/ai',
    },
  })
  ensureUserExists({ email: USER })

  let projectName: string
  let projectId: string

  beforeWithReRunOnTestRetry(() => {
    projectName = `ai-test-${uuid()}`
    login(USER)
    createProjectAndOpenInNewEditor(projectName, {
      type: 'Blank project',
    }).then(id => (projectId = id))
  })

  beforeEach(function () {
    login(USER)
    openProjectById(projectId, true)
  })

  describe('AI Assistant panel', function () {
    it('shows AI Assistant tab in the rail', function () {
      // Find the AI Assistant tab button by its icon or title
      cy.findByRole('tab', { name: /AI Assistant/i }).should('be.visible')
    })

    it('opens AI Assistant panel when tab is clicked', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Panel should be visible with the AI Assistant heading
      cy.findByRole('region', { name: /AI Assistant/i }).should('be.visible')
    })

    it('displays chat input when panel is opened', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Chat input should be visible
      cy.get('#ai-chat-input').should('be.visible')
      cy.get('#ai-chat-input').should(
        'have.attr',
        'placeholder',
        'Ask AI Assistant...'
      )
    })

    it('can send a message and receive a response', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Type a message
      cy.get('#ai-chat-input').type('Hello, can you help me?')

      // Send the message
      cy.findByRole('button', { name: /Send message/i }).click()

      // Wait for the response (streaming)
      cy.findByRole('region', { name: /AI Assistant/i }).within(() => {
        // User message should appear
        cy.contains('Hello, can you help me?').should('be.visible')

        // AI response should appear (mock service returns greeting response)
        cy.contains("I'm your AI writing assistant", { timeout: 10000 }).should(
          'be.visible'
        )
      })
    })

    it('can ask for help and receive assistance', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      cy.get('#ai-chat-input').type('I need help with my document')
      cy.findByRole('button', { name: /Send message/i }).click()

      cy.findByRole('region', { name: /AI Assistant/i }).within(() => {
        // AI should respond with help options
        cy.contains('I can help you with', { timeout: 10000 }).should(
          'be.visible'
        )
      })
    })

    it('can ask about LaTeX and receive code suggestions', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      cy.get('#ai-chat-input').type('How do I write an equation in LaTeX?')
      cy.findByRole('button', { name: /Send message/i }).click()

      cy.findByRole('region', { name: /AI Assistant/i }).within(() => {
        // AI should respond with LaTeX examples
        cy.contains('mathematical equations', { timeout: 10000 }).should(
          'be.visible'
        )
        cy.contains('\\begin{equation}').should('be.visible')
      })
    })

    it('disables send button while streaming', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      cy.get('#ai-chat-input').type('Hello')
      cy.findByRole('button', { name: /Send message/i }).click()

      // Send button should be disabled during streaming
      cy.findByRole('button', { name: /Send message/i }).should('be.disabled')

      // Wait for streaming to complete
      cy.contains("I'm your AI writing assistant", { timeout: 10000 })

      // Send button should be enabled again
      cy.findByRole('button', { name: /Send message/i }).should('not.be.disabled')
    })

    it('can send message with Enter key', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      cy.get('#ai-chat-input').type('Hello{enter}')

      // Message should be sent
      cy.findByRole('region', { name: /AI Assistant/i }).within(() => {
        cy.contains('Hello').should('be.visible')
        cy.contains("I'm your AI writing assistant", { timeout: 10000 }).should(
          'be.visible'
        )
      })
    })

    it('can start a new conversation', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Send a message
      cy.get('#ai-chat-input').type('Hello{enter}')
      cy.contains("I'm your AI writing assistant", { timeout: 10000 })

      // Click the reset/new conversation button
      cy.findByRole('button', { name: /New conversation/i }).click()

      // Messages should be cleared
      cy.findByRole('region', { name: /AI Assistant/i }).within(() => {
        cy.contains('Hello').should('not.exist')
      })
    })

    it('maintains conversation history', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Send first message
      cy.get('#ai-chat-input').type('Hello{enter}')
      cy.contains("I'm your AI writing assistant", { timeout: 10000 })

      // Send second message
      cy.get('#ai-chat-input').type('Can you help me?{enter}')
      cy.contains('I can help you with', { timeout: 10000 })

      // Both messages should be visible
      cy.findByRole('region', { name: /AI Assistant/i }).within(() => {
        cy.contains('Hello').should('be.visible')
        cy.contains('Can you help me?').should('be.visible')
      })
    })
  })

  describe('AI Assistant panel closed state', function () {
    it('can close the panel', function () {
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Panel should be open
      cy.findByRole('region', { name: /AI Assistant/i }).should('be.visible')

      // Click the tab again to close (or click elsewhere)
      cy.findByRole('tab', { name: /AI Assistant/i }).click()

      // Panel should be closed
      cy.findByRole('region', { name: /AI Assistant/i }).should('not.be.visible')
    })
  })
})

describe('ai-assistant disabled', function () {
  if (isExcludedBySharding('CE_DEFAULT')) return

  startWith({
    vars: {
      OVERLEAF_ENABLE_AI_ASSISTANT: 'false',
    },
  })
  ensureUserExists({ email: USER })

  let projectName: string
  let projectId: string

  beforeWithReRunOnTestRetry(() => {
    projectName = `ai-disabled-${uuid()}`
    login(USER)
    createProjectAndOpenInNewEditor(projectName, {
      type: 'Blank project',
    }).then(id => (projectId = id))
  })

  it('does not show AI Assistant tab when disabled', function () {
    login(USER)
    openProjectById(projectId, true)

    // AI Assistant tab should not be visible
    cy.findByRole('tab', { name: /AI Assistant/i }).should('not.exist')
  })
})
