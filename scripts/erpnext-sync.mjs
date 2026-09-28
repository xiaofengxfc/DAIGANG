import { buildERPNextBundle } from '../src/erpnext-map.mjs'
import { syncERPNextMaster, ERPNextError } from '../src/erpnext.mjs'

const args = process.argv.slice(2)
const modeIndex = args.indexOf('--mode')
const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'dry-run'
const confirm = args.includes('--confirm=APPLY') ? 'APPLY' : ''

try {
  const result = await syncERPNextMaster({ mode, confirm }, buildERPNextBundle())
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
