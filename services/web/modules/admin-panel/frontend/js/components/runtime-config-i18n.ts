import { RuntimeConfigEntry } from '../api/runtime-config-api'

type TranslateFn = (
  key: string,
  options?: Record<string, unknown>
) => string

type TranslationDescriptor = {
  key: string
  defaultValue: string
}

const SERVICE_TRANSLATIONS: Record<string, TranslationDescriptor> = {
  web: {
    key: 'admin_runtime_config_service_web',
    defaultValue: 'Web',
  },
  'ai-writing-agent': {
    key: 'admin_runtime_config_service_ai_writing_agent',
    defaultValue: 'AI Writing Agent',
  },
  clsi: {
    key: 'admin_runtime_config_service_clsi',
    defaultValue: 'CLSI',
  },
}

const CATEGORY_TRANSLATIONS: Record<string, TranslationDescriptor> = {
  Operations: {
    key: 'admin_runtime_config_category_operations',
    defaultValue: 'Operations',
  },
  Compile: {
    key: 'admin_runtime_config_category_compile',
    defaultValue: 'Compile',
  },
  'AI Models': {
    key: 'admin_runtime_config_category_ai_models',
    defaultValue: 'AI Models',
  },
  Memory: {
    key: 'admin_runtime_config_category_memory',
    defaultValue: 'Memory',
  },
  Autocomplete: {
    key: 'admin_runtime_config_category_autocomplete',
    defaultValue: 'Autocomplete',
  },
  Attachments: {
    key: 'admin_runtime_config_category_attachments',
    defaultValue: 'Attachments',
  },
  'External APIs': {
    key: 'admin_runtime_config_category_external_apis',
    defaultValue: 'External APIs',
  },
  'Run Budget': {
    key: 'admin_runtime_config_category_run_budget',
    defaultValue: 'Run Budget',
  },
  Confirmation: {
    key: 'admin_runtime_config_category_confirmation',
    defaultValue: 'Confirmation',
  },
  'PDF Caching': {
    key: 'admin_runtime_config_category_pdf_caching',
    defaultValue: 'PDF Caching',
  },
}

const SOURCE_TRANSLATIONS: Record<string, TranslationDescriptor> = {
  default: {
    key: 'admin_runtime_config_source_default',
    defaultValue: 'Default',
  },
  runtime: {
    key: 'admin_runtime_config_source_runtime',
    defaultValue: 'Runtime Override',
  },
  env: {
    key: 'admin_runtime_config_source_env',
    defaultValue: 'Environment',
  },
}

const RELOAD_TRANSLATIONS: Record<string, TranslationDescriptor> = {
  immediate_in_memory: {
    key: 'admin_runtime_config_reload_immediate_in_memory',
    defaultValue: 'Immediate In Memory',
  },
  pubsub_refresh: {
    key: 'admin_runtime_config_reload_pubsub_refresh',
    defaultValue: 'Pub/Sub Refresh',
  },
}

const REVISION_ACTION_TRANSLATIONS: Record<string, TranslationDescriptor> = {
  set: {
    key: 'admin_runtime_config_revision_action_set',
    defaultValue: 'Set',
  },
  reset: {
    key: 'admin_runtime_config_revision_action_reset',
    defaultValue: 'Reset',
  },
  rollback: {
    key: 'admin_runtime_config_revision_action_rollback',
    defaultValue: 'Rollback',
  },
}

function humanizeIdentifier(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function translateDescriptor(
  t: TranslateFn,
  descriptor: TranslationDescriptor | undefined,
  fallback: string
) {
  if (!descriptor) {
    return fallback
  }
  return t(descriptor.key, { defaultValue: descriptor.defaultValue })
}

function sanitizeTranslationSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9]+/g, '_')
}

function getEntryTranslationKey(entry: RuntimeConfigEntry, field: 'label' | 'description') {
  return [
    'admin_runtime_config_entry',
    sanitizeTranslationSegment(entry.service),
    sanitizeTranslationSegment(entry.key),
    field,
  ].join('_')
}

export function getRuntimeConfigServiceLabel(
  service: string,
  t: TranslateFn
) {
  return translateDescriptor(
    t,
    SERVICE_TRANSLATIONS[service],
    humanizeIdentifier(service)
  )
}

export function getRuntimeConfigCategoryLabel(
  category: string,
  t: TranslateFn
) {
  return translateDescriptor(t, CATEGORY_TRANSLATIONS[category], category)
}

export function getRuntimeConfigSourceLabel(source: string, t: TranslateFn) {
  return translateDescriptor(
    t,
    SOURCE_TRANSLATIONS[source],
    humanizeIdentifier(source)
  )
}

export function getRuntimeConfigReloadStrategyLabel(
  reloadStrategy: string,
  t: TranslateFn
) {
  return translateDescriptor(
    t,
    RELOAD_TRANSLATIONS[reloadStrategy],
    humanizeIdentifier(reloadStrategy)
  )
}

export function getRuntimeConfigRevisionActionLabel(
  action: string,
  t: TranslateFn
) {
  return translateDescriptor(
    t,
    REVISION_ACTION_TRANSLATIONS[action],
    humanizeIdentifier(action)
  )
}

export function getRuntimeConfigEntryLabel(
  entry: RuntimeConfigEntry,
  t: TranslateFn
) {
  return t(getEntryTranslationKey(entry, 'label'), {
    defaultValue: entry.label,
  })
}

export function getRuntimeConfigEntryDescription(
  entry: RuntimeConfigEntry,
  t: TranslateFn
) {
  return t(getEntryTranslationKey(entry, 'description'), {
    defaultValue: entry.description,
  })
}

// Keep indirect runtime-config keys visible to i18next-scanner.
export function scanRuntimeConfigTranslationKeys(t: TranslateFn) {
  t('admin_runtime_config_nav_users', { defaultValue: 'Users' })
  t('admin_runtime_config_nav_ai_models', { defaultValue: 'AI Models' })
  t('admin_runtime_config_nav_runtime_config', {
    defaultValue: 'Runtime Config',
  })
  t('admin_runtime_config_service_web', { defaultValue: 'Web' })
  t('admin_runtime_config_service_ai_writing_agent', {
    defaultValue: 'AI Writing Agent',
  })
  t('admin_runtime_config_service_clsi', { defaultValue: 'CLSI' })
  t('admin_runtime_config_category_operations', {
    defaultValue: 'Operations',
  })
  t('admin_runtime_config_category_compile', { defaultValue: 'Compile' })
  t('admin_runtime_config_category_ai_models', {
    defaultValue: 'AI Models',
  })
  t('admin_runtime_config_category_memory', { defaultValue: 'Memory' })
  t('admin_runtime_config_category_autocomplete', {
    defaultValue: 'Autocomplete',
  })
  t('admin_runtime_config_category_attachments', {
    defaultValue: 'Attachments',
  })
  t('admin_runtime_config_category_external_apis', {
    defaultValue: 'External APIs',
  })
  t('admin_runtime_config_category_run_budget', {
    defaultValue: 'Run Budget',
  })
  t('admin_runtime_config_category_confirmation', {
    defaultValue: 'Confirmation',
  })
  t('admin_runtime_config_category_pdf_caching', {
    defaultValue: 'PDF Caching',
  })
  t('admin_runtime_config_source', { defaultValue: 'Source' })
  t('admin_runtime_config_default', { defaultValue: 'Default' })
  t('admin_runtime_config_source_default', { defaultValue: 'Default' })
  t('admin_runtime_config_source_runtime', {
    defaultValue: 'Runtime Override',
  })
  t('admin_runtime_config_source_env', { defaultValue: 'Environment' })
  t('admin_runtime_config_reload_immediate_in_memory', {
    defaultValue: 'Immediate In Memory',
  })
  t('admin_runtime_config_reload_pubsub_refresh', {
    defaultValue: 'Pub/Sub Refresh',
  })
  t('admin_runtime_config_revision_action_set', { defaultValue: 'Set' })
  t('admin_runtime_config_revision_action_reset', { defaultValue: 'Reset' })
  t('admin_runtime_config_revision_action_rollback', {
    defaultValue: 'Rollback',
  })
  t('admin_runtime_config_entry_web_site_isOpen_label', {
    defaultValue: 'Site Open',
  })
  t('admin_runtime_config_entry_web_site_isOpen_description', {
    defaultValue: 'Controls whether the whole site accepts normal traffic.',
  })
  t('admin_runtime_config_entry_web_editor_isOpen_label', {
    defaultValue: 'Editor Open',
  })
  t('admin_runtime_config_entry_web_editor_isOpen_description', {
    defaultValue: 'Controls whether the editor remains open for users.',
  })
  t('admin_runtime_config_entry_web_defaultFeatures_compileTimeout_label', {
    defaultValue: 'Default Compile Timeout',
  })
  t(
    'admin_runtime_config_entry_web_defaultFeatures_compileTimeout_description',
    {
      defaultValue:
        'Default compile timeout in seconds when the owner has no explicit feature override.',
    }
  )
  t('admin_runtime_config_entry_web_defaultFeatures_compileGroup_label', {
    defaultValue: 'Default Compile Group',
  })
  t(
    'admin_runtime_config_entry_web_defaultFeatures_compileGroup_description',
    {
      defaultValue:
        'Default compile group used when the owner has no explicit feature override.',
    }
  )
  t('admin_runtime_config_entry_web_pdfCaching_enabled_label', {
    defaultValue: 'Enable PDF Caching',
  })
  t('admin_runtime_config_entry_web_pdfCaching_enabled_description', {
    defaultValue: 'Enables PDF caching for compatible compile flows.',
  })
  t('admin_runtime_config_entry_web_pdfCaching_minChunkSize_label', {
    defaultValue: 'PDF Caching Min Chunk Size',
  })
  t('admin_runtime_config_entry_web_pdfCaching_minChunkSize_description', {
    defaultValue: 'Minimum PDF chunk size used when PDF caching is enabled.',
  })
  t(
    'admin_runtime_config_entry_ai_writing_agent_modelConfig_cacheTtlMs_label',
    {
      defaultValue: 'Model Config Cache TTL',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_modelConfig_cacheTtlMs_description',
    {
      defaultValue: 'TTL for cached AI model configuration lookups.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_modelConfig_cacheMax_label',
    {
      defaultValue: 'Model Config Cache Max',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_modelConfig_cacheMax_description',
    {
      defaultValue: 'Maximum number of cached AI model configuration entries.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_memory_maxRulesLength_label',
    {
      defaultValue: 'Project Rules Max Length',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_memory_maxRulesLength_description',
    {
      defaultValue:
        'Maximum number of characters allowed in project rules memory content.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_completionRules_maxLength_label',
    {
      defaultValue: 'Completion Rules Max Length',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_completionRules_maxLength_description',
    {
      defaultValue:
        'Maximum number of characters allowed in completion rules content.',
    }
  )
  t('admin_runtime_config_entry_ai_writing_agent_image_maxSize_label', {
    defaultValue: 'Image Max Size',
  })
  t(
    'admin_runtime_config_entry_ai_writing_agent_image_maxSize_description',
    {
      defaultValue: 'Maximum size in bytes for AI image inputs and attachments.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_externalApis_timeout_label',
    {
      defaultValue: 'External API Timeout',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_externalApis_timeout_description',
    {
      defaultValue:
        'Timeout in milliseconds for bibliography lookup external API calls.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_externalApis_maxRetries_label',
    {
      defaultValue: 'External API Max Retries',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_externalApis_maxRetries_description',
    {
      defaultValue: 'Retry count for bibliography lookup external API calls.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_externalApis_maxResponseBytes_label',
    {
      defaultValue: 'External API Max Response Bytes',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_externalApis_maxResponseBytes_description',
    {
      defaultValue:
        'Maximum response payload size accepted from bibliography lookup providers.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxWallTimeMs_label',
    {
      defaultValue: 'Run Budget Max Wall Time',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxWallTimeMs_description',
    {
      defaultValue: 'Maximum wall clock time for one agent run, in milliseconds.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxLLMCalls_label',
    {
      defaultValue: 'Run Budget Max LLM Calls',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxLLMCalls_description',
    {
      defaultValue: 'Maximum number of LLM calls in one run.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxToolCalls_label',
    {
      defaultValue: 'Run Budget Max Tool Calls',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxToolCalls_description',
    {
      defaultValue: 'Maximum number of tool calls in one run.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxTotalTokens_label',
    {
      defaultValue: 'Run Budget Max Total Tokens',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxTotalTokens_description',
    {
      defaultValue: 'Maximum total token budget in one run.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxDepth_label',
    {
      defaultValue: 'Run Budget Max Depth',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxDepth_description',
    {
      defaultValue: 'Maximum delegation depth in one run.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxDelegations_label',
    {
      defaultValue: 'Run Budget Max Delegations',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_runBudget_maxDelegations_description',
    {
      defaultValue: 'Maximum number of delegations in one run.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_defaultTimeoutMs_label',
    {
      defaultValue: 'Confirmation Default Timeout',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_defaultTimeoutMs_description',
    {
      defaultValue: 'Default timeout for pending confirmations in milliseconds.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_maxPending_label',
    {
      defaultValue: 'Confirmation Max Pending',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_maxPending_description',
    {
      defaultValue: 'Maximum number of pending confirmations kept in memory.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_maxEarlyConfirmations_label',
    {
      defaultValue: 'Confirmation Max Early Cache',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_maxEarlyConfirmations_description',
    {
      defaultValue: 'Maximum number of cached early confirmations.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_earlyTtlMs_label',
    {
      defaultValue: 'Confirmation Early TTL',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_earlyTtlMs_description',
    {
      defaultValue: 'TTL for early confirmations in milliseconds.',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_finalizedTtlMs_label',
    {
      defaultValue: 'Confirmation Finalized TTL',
    }
  )
  t(
    'admin_runtime_config_entry_ai_writing_agent_confirmationChannel_finalizedTtlMs_description',
    {
      defaultValue: 'TTL for finalized confirmation ids in milliseconds.',
    }
  )
  t('admin_runtime_config_entry_clsi_compileConcurrencyLimit_label', {
    defaultValue: 'Compile Concurrency Limit',
  })
  t('admin_runtime_config_entry_clsi_compileConcurrencyLimit_description', {
    defaultValue:
      'Maximum number of concurrent compile requests accepted by CLSI.',
  })
  t('admin_runtime_config_entry_clsi_performanceLogSamplingPercentage_label', {
    defaultValue: 'Performance Log Sampling',
  })
  t(
    'admin_runtime_config_entry_clsi_performanceLogSamplingPercentage_description',
    {
      defaultValue: 'Sampling percentage for performance logging.',
    }
  )
  t('admin_runtime_config_entry_clsi_parallelFileDownloads_label', {
    defaultValue: 'Parallel File Downloads',
  })
  t('admin_runtime_config_entry_clsi_parallelFileDownloads_description', {
    defaultValue: 'Parallel download limit when fetching compile resources.',
  })
  t('admin_runtime_config_entry_clsi_maxCompileTimeoutSeconds_label', {
    defaultValue: 'Max Compile Timeout',
  })
  t('admin_runtime_config_entry_clsi_maxCompileTimeoutSeconds_description', {
    defaultValue: 'Maximum compile timeout accepted by CLSI, in seconds.',
  })
  t('admin_runtime_config_entry_clsi_requestTimeoutMs_label', {
    defaultValue: 'CLSI Request Timeout',
  })
  t('admin_runtime_config_entry_clsi_requestTimeoutMs_description', {
    defaultValue:
      'HTTP request timeout for CLSI compile endpoints, in milliseconds.',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_enabled_label', {
    defaultValue: 'Enable PDF Caching',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_enabled_description', {
    defaultValue: 'Enables standard PDF caching in CLSI.',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_enableDark_label', {
    defaultValue: 'Enable Dark PDF Caching',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_enableDark_description', {
    defaultValue: 'Enables dark-mode PDF caching in CLSI.',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_minChunkSize_label', {
    defaultValue: 'PDF Caching Min Chunk Size',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_minChunkSize_description', {
    defaultValue: 'Minimum PDF chunk size eligible for caching.',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_maxProcessingTime_label', {
    defaultValue: 'PDF Caching Max Processing Time',
  })
  t('admin_runtime_config_entry_clsi_pdfCaching_maxProcessingTime_description', {
    defaultValue: 'Maximum processing time for PDF caching work in milliseconds.',
  })
}
