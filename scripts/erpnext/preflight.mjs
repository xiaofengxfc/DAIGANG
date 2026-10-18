import { preflightERPNext, ERPNextError } from '../../src/erpnext/erpnext.mjs'

try {
  const result = await preflightERPNext()
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
