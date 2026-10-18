import { getSetting, setSetting } from '../../core/db.mjs'

export const SETTING_KEYS = Object.freeze([
  'business_name',
  'admin_name',
  'contact',
  'quote_footer',
  'quote_valid_days',
  'default_note',
  'receipt_intro',
])

export function readSettings() {
  const out = {}
  for (const key of SETTING_KEYS) out[key] = getSetting(key, '')
  return out
}

export function updateSettings(values = {}) {
  for (const key of SETTING_KEYS) {
    if (key in values) setSetting(key, values[key])
  }
  return readSettings()
}
