import { buildERPNextBundle } from '../../src/erpnext/erpnext-map.mjs'
import { reconcileERPNext, ERPNextError } from '../../src/erpnext/erpnext.mjs'

const args = process.argv.slice(2)
const index = args.indexOf('--scope')
const scope = index >= 0 ? args[index + 1] : 'all'

try {
  const result = await reconcileERPNext({ scope }, buildERPNextBundle())
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
