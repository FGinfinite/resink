#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Seed script: Migrate current environment variable LLM configuration
 * into the aiModelConfigs / aiModelSlots / aiSystemConfig MongoDB collections.
 *
 * ⚠️  ONE-TIME MIGRATION SCRIPT — This script reads environment variables
 * (OPENAI_API_BASE, OPENAI_API_KEY, etc.) and writes them into MongoDB.
 * After initial deployment, all model configuration should be managed
 * exclusively through the Admin Panel (AI Model Management).
 * Environment variables are NO LONGER used at runtime.
 *
 * Idempotent (upsert): safe to run multiple times.
 *
 * Usage:
 *   cd services/ai-writing-agent && node scripts/seed-model-configs.js
 */

import { MongoClient } from 'mongodb'
import settings from '@overleaf/settings'

const MONGO_URL = settings.mongo?.url ||
  process.env.MONGO_CONNECTION_STRING ||
  'mongodb://127.0.0.1:27017/sharelatex?directConnection=true'
const args = new Set(process.argv.slice(2))
const seedIfMissing = args.has('--if-missing')
const forceSeed = args.has('--force')
const requireOpenAiEnv = args.has('--require-openai-env')

function getRequiredOpenAiEnvVars() {
  return ['OPENAI_API_BASE', 'OPENAI_API_KEY', 'OPENAI_MODEL']
}

function assertRequiredOpenAiEnvVars() {
  const missing = getRequiredOpenAiEnvVars().filter(name => {
    const value = process.env[name]
    return value === undefined || value.trim() === ''
  })

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for AI model seed: ${missing.join(', ')}`
    )
  }
}

async function main() {
  console.log('Connecting to MongoDB...')
  const client = new MongoClient(MONGO_URL, settings.mongo?.options || {})
  await client.connect()
  const db = client.db()

  const aiModelConfigs = db.collection('aiModelConfigs')
  const aiModelSlots = db.collection('aiModelSlots')
  const aiSystemConfig = db.collection('aiSystemConfig')

  if (seedIfMissing && !forceSeed) {
    const existingSystemConfig = await aiSystemConfig.findOne(
      { key: 'modelConfig' },
      { projection: { defaultSlot: 1 } }
    )
    const enabledConfigCount = await aiModelConfigs.countDocuments({ enabled: true })
    if (existingSystemConfig?.defaultSlot && enabledConfigCount > 0) {
      console.log('Model config already exists, skipping seed.')
      await client.close()
      return
    }
  }

  if (forceSeed) {
    console.log('--force: overwriting existing model configs with current env vars')
  }

  if (requireOpenAiEnv) {
    assertRequiredOpenAiEnvVars()
  }

  // Read LLM config directly from env vars (settings.llm has been removed)
  const llm = {
    apiBase: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS, 10) || 4096,
    temperature: parseFloat(process.env.OPENAI_TEMPERATURE) || 0.7,
    timeout: parseInt(process.env.OPENAI_TIMEOUT, 10) || 60000,
    retryAttempts: parseInt(process.env.OPENAI_RETRY_ATTEMPTS, 10) || 6,
    retryDelay: parseInt(process.env.OPENAI_RETRY_DELAY, 10) || 2000,
    proxy: process.env.OPENAI_PROXY || '',
    maxRetryTimeMs: parseInt(process.env.LLM_MAX_RETRY_TIME_MS, 10) || 120000,
    maxToolCallTemperature: parseFloat(process.env.LLM_MAX_TOOL_CALL_TEMPERATURE) || 0.5,
  }
  // Read autocomplete LLM config directly from env vars (falls back to main LLM vars)
  const autocomplete = {
    apiBase: process.env.AUTOCOMPLETE_API_BASE || llm.apiBase,
    apiKey: process.env.AUTOCOMPLETE_API_KEY || llm.apiKey,
    model: process.env.AUTOCOMPLETE_MODEL || 'gpt-4o-mini',
    maxTokens: parseInt(process.env.AUTOCOMPLETE_MAX_TOKENS, 10) || 128,
    temperature: parseFloat(process.env.AUTOCOMPLETE_TEMPERATURE ?? '0'),
    timeout: parseInt(process.env.AUTOCOMPLETE_TIMEOUT, 10) || 8000,
    retryAttempts: parseInt(process.env.AUTOCOMPLETE_RETRY_ATTEMPTS, 10) || 1,
    retryDelay: parseInt(process.env.AUTOCOMPLETE_RETRY_DELAY, 10) || 500,
    proxy: process.env.AUTOCOMPLETE_PROXY || '',
  }

  const now = new Date()

  // -----------------------------------------------------------------------
  // 1. Upsert model configs
  // -----------------------------------------------------------------------

  console.log('Upserting model configs...')

  const mainModelResult = await aiModelConfigs.findOneAndUpdate(
    { slug: 'main-model' },
    {
      $set: {
        slug: 'main-model',
        displayName: 'Main Model',
        apiBase: llm.apiBase || 'https://api.openai.com/v1',
        apiKey: llm.apiKey || '',
        model: llm.model || 'gpt-4o',
        maxTokens: llm.maxTokens || 4096,
        temperature: llm.temperature ?? 0.7,
        timeout: llm.timeout || 60000,
        retryAttempts: llm.retryAttempts || 6,
        retryDelay: llm.retryDelay || 2000,
        maxRetryTimeMs: llm.maxRetryTimeMs || 120000,
        proxy: llm.proxy || '',
        supportsImage: true,
        maxToolCallTemperature: llm.maxToolCallTemperature ?? 0.5,
        enabled: true,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  )
  const mainModelId = mainModelResult._id
  console.log(`  main-model: ${mainModelId}`)

  const autocompleteModelResult = await aiModelConfigs.findOneAndUpdate(
    { slug: 'autocomplete-model' },
    {
      $set: {
        slug: 'autocomplete-model',
        displayName: 'Autocomplete Model',
        apiBase: autocomplete.apiBase || llm.apiBase || 'https://api.openai.com/v1',
        apiKey: autocomplete.apiKey || llm.apiKey || '',
        model: autocomplete.model || 'gpt-4o-mini',
        maxTokens: autocomplete.maxTokens || 128,
        temperature: autocomplete.temperature ?? 0.0,
        timeout: autocomplete.timeout || 8000,
        retryAttempts: autocomplete.retryAttempts || 1,
        retryDelay: autocomplete.retryDelay || 500,
        proxy: autocomplete.proxy || '',
        supportsImage: false,
        enabled: true,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  )
  const autocompleteModelId = autocompleteModelResult._id
  console.log(`  autocomplete-model: ${autocompleteModelId}`)

  // -----------------------------------------------------------------------
  // 2. Upsert model slots
  // -----------------------------------------------------------------------

  console.log('Upserting model slots...')

  const slots = [
    {
      slug: 'advanced',
      label: '\u9AD8\u7EA7\u6A21\u578B',
      modelConfigId: mainModelId,
      sortOrder: 1,
      icon: 'auto_awesome',
    },
    {
      slug: 'balanced',
      label: '\u5E73\u8861\u6A21\u578B',
      modelConfigId: mainModelId,
      sortOrder: 2,
      icon: 'balance',
    },
    {
      slug: 'fast',
      label: '\u5FEB\u901F\u6A21\u578B',
      modelConfigId: autocompleteModelId,
      sortOrder: 3,
      icon: 'bolt',
    },
  ]

  for (const slot of slots) {
    await aiModelSlots.updateOne(
      { slug: slot.slug },
      {
        $set: {
          ...slot,
          enabled: true,
          updatedAt: now,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true }
    )
    console.log(`  slot "${slot.slug}": modelConfigId=${slot.modelConfigId}`)
  }

  // -----------------------------------------------------------------------
  // 3. Upsert system config
  // -----------------------------------------------------------------------

  console.log('Upserting system config...')

  await aiSystemConfig.updateOne(
    { key: 'modelConfig' },
    {
      $set: {
        key: 'modelConfig',
        defaultSlot: 'balanced',
        featureBindings: {
          quickEdit: 'fast',
          autocomplete: 'fast',
          powerfulCompletion: 'fast',
          digestModel: 'fast',
        },
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  )
  console.log('  key="modelConfig", defaultSlot="balanced"')

  // -----------------------------------------------------------------------
  // Done
  // -----------------------------------------------------------------------

  console.log('\nSeed complete.')
  await client.close()
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
