const http = require('node:http')
const https = require('node:https')

http.globalAgent.keepAlive = false
https.globalAgent.keepAlive = false

function parseIntEnv(envValue, defaultValue) {
  if (envValue === undefined || envValue === '') return defaultValue
  const parsed = parseInt(envValue, 10)
  return isNaN(parsed) ? defaultValue : parsed
}

function parseFloatEnv(envValue, defaultValue) {
  if (envValue === undefined || envValue === '') return defaultValue
  const parsed = parseFloat(envValue)
  return isNaN(parsed) ? defaultValue : parsed
}

module.exports = {
  internal: {
    aiWritingAgent: {
      host: process.env.LISTEN_ADDRESS || '127.0.0.1',
      port: parseIntEnv(process.env.PORT, 3060),
    },
    // SECURITY: proxySecret authenticates requests from web proxy.
    // When empty, app.js startup guard will:
    //   - EXIT in production or non-loopback listen address
    //   - WARN in development with loopback listen address
    // The proxy auth middleware (default-deny) rejects all non-loopback
    // requests when secret is empty. Always set AI_PROXY_SECRET in production.
    proxySecret: process.env.AI_PROXY_SECRET || '',
  },

  apis: {
    documentUpdater: {
      url: `http://${process.env.DOCUMENT_UPDATER_HOST || '127.0.0.1'}:${
        process.env.DOCUMENT_UPDATER_PORT || 3003
      }`,
    },
    web: {
      url: `http://${process.env.WEB_HOST || '127.0.0.1'}:${
        process.env.WEB_PORT || 3000
      }`,
      user: process.env.WEB_API_USER || 'overleaf',
      pass: process.env.WEB_API_PASSWORD || 'overleaf',
    },
  },

  mongo: {
    url:
      process.env.MONGO_CONNECTION_STRING ||
      `mongodb://${process.env.MONGO_HOST || '127.0.0.1'}/sharelatex`,
    options: {
      monitorCommands: process.env.MONGO_MONITOR_COMMANDS === 'true',
    },
  },

  redis: {
    pubsub: {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || '6379',
      password: process.env.REDIS_PASSWORD || '',
    },
  },

  runtimeConfig: {
    cacheTtlMs: parseIntEnv(process.env.RUNTIME_CONFIG_CACHE_TTL_MS, 30000),
    fallbackRefreshIntervalMs: parseIntEnv(
      process.env.RUNTIME_CONFIG_FALLBACK_REFRESH_INTERVAL_MS,
      30000
    ),
  },

  shutdown: {
    timeoutMs: parseIntEnv(process.env.SHUTDOWN_TIMEOUT_MS, 10000),
  },

  llmStream: {
    maxBufferChars: parseIntEnv(process.env.LLM_STREAM_MAX_BUFFER_CHARS, 524288),
    maxContentChars: parseIntEnv(process.env.LLM_STREAM_MAX_CONTENT_CHARS, 2097152),
    maxToolArgsChars: parseIntEnv(process.env.LLM_STREAM_MAX_TOOL_ARGS_CHARS, 524288),
  },

  documentEdit: {
    anchorLength: parseIntEnv(process.env.DOCUMENT_EDIT_ANCHOR_LENGTH, 100),
    maxRetries: parseIntEnv(process.env.DOCUMENT_EDIT_MAX_RETRIES, 1),
    maxShift: parseIntEnv(process.env.DOCUMENT_EDIT_MAX_SHIFT, 500),
    disambiguationRatio: parseFloatEnv(process.env.DOCUMENT_EDIT_DISAMBIGUATION_RATIO, 2.0),
    maxOldTextLength: parseIntEnv(process.env.DOCUMENT_EDIT_MAX_OLD_TEXT_LENGTH, 102400),
    maxNewTextLength: parseIntEnv(process.env.DOCUMENT_EDIT_MAX_NEW_TEXT_LENGTH, 102400),
    apiTimeoutMs: parseIntEnv(process.env.DOCUMENT_EDIT_API_TIMEOUT_MS, 30000),
  },

  projectCache: {
    entityCacheMax: parseIntEnv(process.env.PROJECT_ENTITY_CACHE_MAX, 500),
    entityCacheTtlMs: parseIntEnv(process.env.PROJECT_ENTITY_CACHE_TTL_MS, 300000),
  },

  fileStoreAdapter: {
    uploadMaxSize: parseIntEnv(process.env.FILESTORE_UPLOAD_MAX_SIZE, 5242880),
    downloadMaxSize: parseIntEnv(process.env.FILESTORE_DOWNLOAD_MAX_SIZE, 5242880),
    timeoutMs: parseIntEnv(process.env.FILESTORE_TIMEOUT_MS, 60000),
  },

  projectAccess: {
    cacheTtlMs: parseIntEnv(process.env.PROJECT_ACCESS_CACHE_TTL_MS, 10000),
    controllerCacheTtlMs: parseIntEnv(process.env.PROJECT_ACCESS_CONTROLLER_CACHE_TTL_MS, 60000),
    requestTimeoutMs: parseIntEnv(process.env.PROJECT_ACCESS_REQUEST_TIMEOUT_MS, 5000),
    cacheCleanupThreshold: parseIntEnv(process.env.PROJECT_ACCESS_CACHE_CLEANUP_THRESHOLD, 5000),
    cacheForceCleanupThreshold: parseIntEnv(process.env.PROJECT_ACCESS_CACHE_FORCE_CLEANUP_THRESHOLD, 20000),
    rateLimitMapCleanupThreshold: parseIntEnv(process.env.PROJECT_ACCESS_RATE_MAP_CLEANUP_THRESHOLD, 10000),
    rateLimitMapForceCleanupThreshold: parseIntEnv(process.env.PROJECT_ACCESS_RATE_MAP_FORCE_CLEANUP_THRESHOLD, 20000),
  },

  quickEdit: {
    rateLimitWindowMs: parseIntEnv(process.env.QUICK_EDIT_RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: parseIntEnv(process.env.QUICK_EDIT_RATE_LIMIT_MAX, 30),
    maxSelectionLength: parseIntEnv(process.env.QUICK_EDIT_MAX_SELECTION_LENGTH, 10000),
    maxSurroundingContext: parseIntEnv(process.env.QUICK_EDIT_MAX_SURROUNDING_CONTEXT, 20000),
    maxTokens: parseIntEnv(process.env.QUICK_EDIT_MAX_TOKENS, 4096),
    minTokens: parseIntEnv(process.env.QUICK_EDIT_MIN_TOKENS, 256),
  },

  list: {
    maxPatternLength: parseIntEnv(process.env.LIST_MAX_PATTERN_LENGTH, 200),
    lineCountMaxFiles: parseIntEnv(process.env.LIST_LINE_COUNT_MAX_FILES, 50),
  },

  skills: {
    maxBodyLength: parseIntEnv(process.env.SKILL_MAX_BODY_LENGTH, 32768),
    maxNameLength: parseIntEnv(process.env.SKILL_MAX_NAME_LENGTH, 64),
    maxDescriptionLength: parseIntEnv(process.env.SKILL_MAX_DESCRIPTION_LENGTH, 256),
    maxTriggerHintLength: parseIntEnv(process.env.SKILL_MAX_TRIGGER_HINT_LENGTH, 256),
  },

  agentTypes: {
    maxTurnsLimit: parseIntEnv(process.env.AGENT_TYPE_MAX_TURNS_LIMIT, 50),
    maxToolsPerAgent: parseIntEnv(process.env.AGENT_TYPE_MAX_TOOLS_PER_AGENT, 20),
    maxBodyLength: parseIntEnv(process.env.AGENT_TYPE_MAX_BODY_LENGTH, 32768),
    maxNameLength: parseIntEnv(process.env.AGENT_TYPE_MAX_NAME_LENGTH, 64),
    maxDescriptionLength: parseIntEnv(process.env.AGENT_TYPE_MAX_DESCRIPTION_LENGTH, 256),
  },

  replacer: {
    maxLevenshteinLength: parseIntEnv(process.env.REPLACER_MAX_LEVENSHTEIN_LENGTH, 5000),
  },

  modelConfig: {
    cacheTtlMs: parseIntEnv(process.env.MODEL_CONFIG_CACHE_TTL_MS, 60000),
    cacheMax: parseIntEnv(process.env.MODEL_CONFIG_CACHE_MAX, 100),
  },

  // llm: LLM connection settings are managed via MongoDB (aiModelConfigs).
  // Run `node scripts/seed-model-configs.js` to initialize from env vars on first deploy.

  autocomplete: {
    // LLM connection settings (apiBase/apiKey/model etc.) are now managed via
    // MongoDB featureBindings. These non-LLM parameters are still read directly.
    prefixChars: parseIntEnv(process.env.AUTOCOMPLETE_PREFIX_CHARS, 2000),
    suffixChars: parseIntEnv(process.env.AUTOCOMPLETE_SUFFIX_CHARS, 500),
    contextMaxChars: parseIntEnv(process.env.AUTOCOMPLETE_CONTEXT_MAX_CHARS, 4000),
    contextMaxFiles: parseIntEnv(process.env.AUTOCOMPLETE_CONTEXT_MAX_FILES, 5),
    // Reasoning model controls
    disableReasoning: process.env.AUTOCOMPLETE_DISABLE_REASONING === 'true',
    maxCompletionTokens: parseIntEnv(process.env.AUTOCOMPLETE_MAX_COMPLETION_TOKENS, 0),
    maxPrefixLength: parseIntEnv(process.env.AUTOCOMPLETE_MAX_PREFIX_LENGTH, 50000),
    maxSuffixLength: parseIntEnv(process.env.AUTOCOMPLETE_MAX_SUFFIX_LENGTH, 50000),
    maxFilenameLength: parseIntEnv(process.env.AUTOCOMPLETE_MAX_FILENAME_LENGTH, 500),
    rateLimitWindowMs: parseIntEnv(process.env.AUTOCOMPLETE_RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: parseIntEnv(process.env.AUTOCOMPLETE_RATE_LIMIT_MAX, 60),
    minPrefixLength: parseIntEnv(process.env.AUTOCOMPLETE_MIN_PREFIX_LENGTH, 10),
    maxSurroundingContext: parseIntEnv(process.env.AUTOCOMPLETE_MAX_SURROUNDING_CONTEXT, 20000),
    digest: {
      maxTokens: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_MAX_TOKENS, 800),
      maxContentChars: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_MAX_CONTENT_CHARS, 30000),
      absoluteExpiryMs: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_ABSOLUTE_EXPIRY_MS, 1800000),
      cacheMaxSize: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_CACHE_MAX_SIZE, 100),
      minDocumentChars: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_MIN_DOC_CHARS, 1000),
      minOutlineChars: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_MIN_OUTLINE_CHARS, 3000),
      globalSummaryMaxChars: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_GLOBAL_SUMMARY_MAX_CHARS, 2000),
      sectionTitleMaxLength: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_SECTION_TITLE_MAX_LENGTH, 200),
      sectionDescMaxLength: parseIntEnv(process.env.AUTOCOMPLETE_DIGEST_SECTION_DESC_MAX_LENGTH, 1000),
    },
    contextCacheTtl: parseIntEnv(process.env.AUTOCOMPLETE_CONTEXT_CACHE_TTL, 10000),
    contextCacheMax: parseIntEnv(process.env.AUTOCOMPLETE_CONTEXT_CACHE_MAX, 200),
  },

  powerfulCompletion: {
    prefixChars: parseIntEnv(process.env.POWERFUL_COMPLETION_PREFIX_CHARS, 8000),
    suffixChars: parseIntEnv(process.env.POWERFUL_COMPLETION_SUFFIX_CHARS, 2000),
    maxTokens: parseIntEnv(process.env.POWERFUL_COMPLETION_MAX_TOKENS, 512),
    contextMaxChars: parseIntEnv(process.env.POWERFUL_COMPLETION_CONTEXT_MAX_CHARS, 8000),
    contextMaxFiles: parseIntEnv(process.env.POWERFUL_COMPLETION_CONTEXT_MAX_FILES, 8),
    rateLimitWindowMs: parseIntEnv(process.env.POWERFUL_COMPLETION_RATE_LIMIT_WINDOW_MS, 60000),
    rateLimitMax: parseIntEnv(process.env.POWERFUL_COMPLETION_RATE_LIMIT_MAX, 20),
    temperature: parseFloatEnv(process.env.POWERFUL_COMPLETION_TEMPERATURE, 0.0),
    disableReasoning: process.env.POWERFUL_COMPLETION_DISABLE_REASONING === 'true',
    maxCompletionTokens: parseIntEnv(process.env.POWERFUL_COMPLETION_MAX_COMPLETION_TOKENS, 0),
  },

  completionRules: {
    maxLength: parseIntEnv(process.env.COMPLETION_RULES_MAX_LENGTH, 2000),
  },

  agent: {
    maxTurns: parseIntEnv(process.env.AGENT_MAX_TURNS, 10),
    maxToolCalls: parseIntEnv(process.env.AGENT_MAX_TOOL_CALLS, 20),
    sessionTimeout: parseIntEnv(process.env.AGENT_SESSION_TIMEOUT, 1800000), // 30 minutes
    depthLimit: parseIntEnv(process.env.AGENT_DEPTH_LIMIT, 20),
    estimatedCharsPerToken: parseIntEnv(process.env.AGENT_ESTIMATED_CHARS_PER_TOKEN, 4),
    toolTimeoutMs: parseIntEnv(process.env.AGENT_TOOL_TIMEOUT_MS, 300000),
  },

  aiAssistant: {
    // SSE streaming
    maxSseQueue: parseIntEnv(process.env.AI_MAX_SSE_QUEUE, 200),
    backpressureLimit: parseIntEnv(process.env.AI_BACKPRESSURE_LIMIT, 50),
    drainTimeoutMs: parseIntEnv(process.env.AI_DRAIN_TIMEOUT_MS, 5000),

    // Session management
    sessionPageSize: parseIntEnv(process.env.AI_SESSION_PAGE_SIZE, 200),
    sessionPageMax: parseIntEnv(process.env.AI_SESSION_PAGE_MAX, 500),
    maxChangeHistoryItems: parseIntEnv(process.env.AI_MAX_CHANGE_HISTORY, 200),
    maxMessageChars: parseIntEnv(process.env.AI_MAX_MESSAGE_CHARS, 2000000),
    maxSessionTitleLength: parseIntEnv(process.env.AI_MAX_SESSION_TITLE_LENGTH, 200),
    maxConcurrentSessions: parseIntEnv(process.env.AI_MAX_CONCURRENT_SESSIONS, 3),

    // Agent limits
    maxSelectionReferences: parseIntEnv(process.env.AI_MAX_SELECTION_REFERENCES, 20),

    // Prompt sanitization
    maxPromptInlineLength: parseIntEnv(process.env.AI_MAX_PROMPT_INLINE_LENGTH, 200),
    maxPromptBlockLength: parseIntEnv(process.env.AI_MAX_PROMPT_BLOCK_LENGTH, 10000),

    // Rate limiting (per user)
    messageRateMax: parseIntEnv(process.env.AI_MESSAGE_RATE_MAX, 60),
    messageRateWindowMs: parseIntEnv(process.env.AI_MESSAGE_RATE_WINDOW_MS, 60000),
    uploadRateMax: parseIntEnv(process.env.AI_UPLOAD_RATE_MAX, 20),
    uploadRateWindowMs: parseIntEnv(process.env.AI_UPLOAD_RATE_WINDOW_MS, 60000),

    streamingContextMaxItems: parseIntEnv(process.env.AI_STREAMING_CONTEXT_MAX_ITEMS, 200),
    attachmentUnreferencedTtlMs: parseIntEnv(process.env.AI_UNREFERENCED_ATTACHMENT_TTL_MS, 86400000),
    attachmentReferencedTtlMs: parseIntEnv(process.env.AI_REFERENCED_ATTACHMENT_TTL_MS, 259200000),
    changeLockTtlMs: parseIntEnv(process.env.AI_CHANGE_LOCK_TTL_MS, 120000),
    maxSelectionChars: parseIntEnv(process.env.AI_MAX_SELECTION_CHARS, 16000),
  },

  runBudget: {
    maxWallTimeMs: parseIntEnv(process.env.RUN_BUDGET_MAX_WALL_TIME_MS, 1800000),
    maxLLMCalls: parseIntEnv(process.env.RUN_BUDGET_MAX_LLM_CALLS, 30),
    maxToolCalls: parseIntEnv(process.env.RUN_BUDGET_MAX_TOOL_CALLS, 70),
    maxTotalTokens: parseIntEnv(process.env.RUN_BUDGET_MAX_TOTAL_TOKENS, 200000),
    maxDepth: parseIntEnv(process.env.RUN_BUDGET_MAX_DEPTH, 1),
    maxDelegations: parseIntEnv(process.env.RUN_BUDGET_MAX_DELEGATIONS, 6),
  },

  confirmationChannel: {
    timeout: parseIntEnv(process.env.CONFIRMATION_TIMEOUT_MS, 1800000), // 30 min
    maxPending: parseIntEnv(process.env.CONFIRMATION_MAX_PENDING, 500),
    defaultTimeoutMs: parseIntEnv(process.env.CONFIRMATION_DEFAULT_TIMEOUT_MS, 1800000),
    maxEarlyConfirmations: parseIntEnv(process.env.CONFIRMATION_MAX_EARLY, 100),
    earlyTtlMs: parseIntEnv(process.env.CONFIRMATION_EARLY_TTL_MS, 30000),
    finalizedTtlMs: parseIntEnv(process.env.CONFIRMATION_FINALIZED_TTL_MS, 60000),
  },

  document: {
    maxLines: parseIntEnv(process.env.DOCUMENT_MAX_LINES, 1000),
    maxChars: parseIntEnv(process.env.DOCUMENT_MAX_CHARS, 50000),
    maxContentLength: parseIntEnv(process.env.DOCUMENT_MAX_CONTENT_LENGTH, 100000),
    contentCacheSize: parseIntEnv(process.env.DOCUMENT_CONTENT_CACHE_SIZE, 50),
    maxReadLines: parseIntEnv(process.env.DOCUMENT_MAX_READ_LINES, 2000),
    deletePreviewMaxChars: parseIntEnv(process.env.DOCUMENT_DELETE_PREVIEW_MAX_CHARS, 50000),
    outlineMaxEntries: parseIntEnv(process.env.DOCUMENT_OUTLINE_MAX_ENTRIES, 30),
  },

  search: {
    maxResults: parseIntEnv(process.env.SEARCH_MAX_RESULTS, 50),
    defaultContextLines: parseIntEnv(process.env.SEARCH_DEFAULT_CONTEXT_LINES, 2),
    maxContextLines: parseIntEnv(process.env.SEARCH_MAX_CONTEXT_LINES, 20),
    maxPatternLength: parseIntEnv(process.env.SEARCH_MAX_PATTERN_LENGTH, 500),
    maxScanBytes: parseIntEnv(process.env.SEARCH_MAX_SCAN_BYTES, 2000000),
    maxFiles: parseIntEnv(process.env.SEARCH_MAX_FILES, 200),
    maxFileSize: parseIntEnv(process.env.SEARCH_MAX_FILE_SIZE, 500000),
    maxLineLength: parseIntEnv(process.env.SEARCH_MAX_LINE_LENGTH, 2000),
  },

  review: {
    maxTurns: parseIntEnv(process.env.REVIEW_MAX_TURNS, 15),
    maxToolCalls: parseIntEnv(process.env.REVIEW_MAX_TOOL_CALLS, 30),
    subAgentMaxTokens: parseIntEnv(process.env.REVIEW_SUB_AGENT_MAX_TOKENS, 8192),
    subAgentTemperature: parseFloatEnv(process.env.REVIEW_SUB_AGENT_TEMPERATURE, 0.3),
  },

  memory: {
    maxRulesLength: parseIntEnv(process.env.MEMORY_MAX_RULES_LENGTH, 10000),
    maxToolContextItems: parseIntEnv(process.env.MEMORY_MAX_TOOL_CONTEXT_ITEMS, 200),
    summaryMaxLength: parseIntEnv(process.env.MEMORY_SUMMARY_MAX_LENGTH, 8000),
    maxInlineNameLength: parseIntEnv(process.env.MEMORY_MAX_INLINE_NAME_LENGTH, 200),
    maxHistoryAttachments: parseIntEnv(process.env.MEMORY_MAX_HISTORY_ATTACHMENTS, 20),
    maxHistoryMessages: parseIntEnv(process.env.MEMORY_MAX_HISTORY_MESSAGES, 50),
    maxContextLength: parseIntEnv(process.env.MEMORY_MAX_CONTEXT_LENGTH, 100000),
  },

  image: {
    maxSize: parseIntEnv(process.env.IMAGE_MAX_SIZE, 5 * 1024 * 1024),
    allowedMimes: [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
      'text/plain', 'text/markdown', 'text/csv',
      'application/json',
    ],
    // supportsImage is now per-model-config (stored in DB)
  },

  fileStore: {
    maxProjectFileDownloadSize: parseInt(process.env.PROJECT_FILE_MAX_SIZE, 10) || 0,
  },

  externalApis: {
    semanticScholar: {
      apiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || '',
      baseUrl: process.env.SEMANTIC_SCHOLAR_BASE_URL || 'https://api.semanticscholar.org/graph/v1',
    },
    crossref: {
      email: process.env.CROSSREF_EMAIL || '',
      baseUrl: process.env.CROSSREF_BASE_URL || 'https://api.crossref.org',
    },
    arxiv: {
      baseUrl: process.env.ARXIV_BASE_URL || 'https://export.arxiv.org/api',
    },
    timeout: parseIntEnv(process.env.EXTERNAL_API_TIMEOUT, 10000),
    maxRetries: parseIntEnv(process.env.EXTERNAL_API_MAX_RETRIES, 2),
    bibLookup: {
      defaultLimit: parseIntEnv(process.env.BIB_LOOKUP_DEFAULT_LIMIT, 5),
      maxLimit: parseIntEnv(process.env.BIB_LOOKUP_MAX_LIMIT, 20),
      maxTitleLength: parseIntEnv(process.env.BIB_LOOKUP_MAX_TITLE_LENGTH, 300),
      maxAuthorLength: parseIntEnv(process.env.BIB_LOOKUP_MAX_AUTHOR_LENGTH, 100),
      maxAbstractLength: parseIntEnv(process.env.BIB_LOOKUP_MAX_ABSTRACT_LENGTH, 1500),
      maxVenueLength: parseIntEnv(process.env.BIB_LOOKUP_MAX_VENUE_LENGTH, 200),
    },
    retryAfterCapSeconds: parseIntEnv(process.env.EXTERNAL_API_RETRY_AFTER_CAP_SECONDS, 30),
    maxResponseBytes: parseIntEnv(process.env.EXTERNAL_API_MAX_RESPONSE_BYTES, 5242880),
  },

  compaction: {
    enabled: process.env.COMPACTION_ENABLED !== 'false',
    contextWindow: parseIntEnv(process.env.CONTEXT_WINDOW, 131072),
    threshold: parseFloatEnv(process.env.COMPACTION_THRESHOLD, 0.7),
    summaryMaxTokens: parseIntEnv(process.env.COMPACTION_SUMMARY_MAX_TOKENS, 2048),
    messageThreshold: parseIntEnv(process.env.COMPACTION_MESSAGE_THRESHOLD, 30),
  },
}
