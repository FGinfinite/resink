import { useTranslation } from 'react-i18next'
import usePersistedState from '@/shared/hooks/use-persisted-state'

export default function AIAutocompleteToggle() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = usePersistedState<boolean>(
    'ai-autocomplete-enabled',
    true
  )

  return (
    <label className="ai-autocomplete-toggle">
      <input
        type="checkbox"
        checked={!!enabled}
        onChange={e => setEnabled(e.target.checked)}
      />
      {t('tab_autocomplete', { defaultValue: 'Tab Autocomplete' })}
    </label>
  )
}
