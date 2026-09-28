import { buildERPNextBundle } from '../src/erpnext-map.mjs'
import { syncERPNextTransactions, ERPNextError } from '../src/erpnext.mjs'

const args = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const scope = valueAfter('--scope', 'all')
const mode = valueAfter('--mode', 'dry-run')
const confirm = args.includes('--confirm=APPLY') ? 'APPLY' : ''

try {
  const result = await syncERPNextTransactions({ scope, mode, confirm }, buildERPNextBundle())
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 2
} catch (err) {
  if (err instanceof ERPNextError) {
    console.error(JSON.stringify({ ok: false, code: err.code, message: err.message }, null, 2))
    process.exitCode = 2
  } else {
    throw err
  }
}
