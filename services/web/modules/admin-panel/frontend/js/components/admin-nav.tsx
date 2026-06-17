import React from 'react'
import { useTranslation } from 'react-i18next'

type AdminNavItem = {
  href: string
  labelKey: string
  defaultLabel: string
}

const NAV_ITEMS: AdminNavItem[] = [
  {
    href: '/admin/users',
    labelKey: 'admin_runtime_config_nav_users',
    defaultLabel: 'Users',
  },
  {
    href: '/admin/ai-models',
    labelKey: 'admin_runtime_config_nav_ai_models',
    defaultLabel: 'AI Models',
  },
  {
    href: '/admin/config',
    labelKey: 'admin_runtime_config_nav_runtime_config',
    defaultLabel: 'Runtime Config',
  },
]

type AdminNavProps = {
  currentPath: string
}

export default function AdminNav({ currentPath }: AdminNavProps) {
  const { t } = useTranslation()

  return (
    <ul className="nav nav-pills" style={{ marginBottom: '20px' }}>
      {NAV_ITEMS.map(item => {
        const isActive = currentPath === item.href
        return (
          <li key={item.href} className={isActive ? 'active' : ''}>
            <a href={item.href}>
              {t(item.labelKey, { defaultValue: item.defaultLabel })}
            </a>
          </li>
        )
      })}
    </ul>
  )
}
