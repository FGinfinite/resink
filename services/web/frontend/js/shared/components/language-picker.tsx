import React from 'react'
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownToggle,
  DropdownHeader,
} from './dropdown/dropdown-menu'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import MaterialIcon from '@/shared/components/material-icon'
import { useLocation } from '@/shared/hooks/use-location'

function LanguagePicker({ showHeader } = { showHeader: false }) {
  const { t } = useTranslation()
  const { reload } = useLocation()

  const currentLangCode = getMeta('ol-i18n').currentLangCode
  const translatedLanguages = getMeta('ol-footer').translatedLanguages
  const subdomainLang = getMeta('ol-footer').subdomainLang
  const handleLanguageChange = (lngCode: string) => {
    if (lngCode === currentLangCode) return
    const safeLngCode = lngCode.replace(/[^a-zA-Z0-9_-]/g, '')
    document.cookie = `i18next=${safeLngCode};path=/;max-age=${365 * 24 * 60 * 60};SameSite=Strict`
    reload()
  }

  return (
    <Dropdown drop="up">
      <DropdownToggle
        id="language-picker-toggle"
        aria-label={t('select_a_language')}
        data-bs-toggle="dropdown"
        className="btn-inline-link"
        variant="link"
      >
        <MaterialIcon type="translate" />
        &nbsp;
        <span className="language-picker-text">
          {translatedLanguages?.[currentLangCode]}
        </span>
      </DropdownToggle>

      <DropdownMenu
        className="dropdown-menu-sm-width"
        aria-labelledby="language-picker-toggle"
      >
        {showHeader ? <DropdownHeader>{t('language')}</DropdownHeader> : null}
        {subdomainLang &&
          Object.entries(subdomainLang).map(([subdomain, subdomainDetails]) => {
            if (
              !subdomainDetails ||
              !subdomainDetails.lngCode ||
              subdomainDetails.hide
            )
              return null
            const isActive = subdomainDetails.lngCode === currentLangCode
            return (
              <li role="none" key={subdomain} translate="no">
                <DropdownItem
                  onClick={() => handleLanguageChange(subdomainDetails.lngCode)}
                  active={isActive}
                  aria-current={isActive ? 'true' : false}
                  trailingIcon={isActive ? 'check' : null}
                >
                  {translatedLanguages?.[subdomainDetails.lngCode]}
                </DropdownItem>
              </li>
            )
          })}
      </DropdownMenu>
    </Dropdown>
  )
}

export default LanguagePicker
