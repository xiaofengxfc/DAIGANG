import { ERPNextError } from '../src/erpnext.mjs'
import { resticStatus, listResticSnapshots, createResticBackup } from '../src/restic.mjs'

const args = process.argv.slice(2)
const modeIndex = args.indexOf('--mode')
const mode = modeIndex >= 0 ? args[modeIndex + 1] : 'status'
const confirm = args.includes('--confirm=BACKUP')

try {
  if (mode === 'status') console.log(JSON.stringify(resticStatus(), null, 2))
  else if (mode === 'snapshots') console.log(JSON.stringify(await listResticSnapshots(), null, 2))
  else if (mode === 'backup') {
    if (!confirm) throw new ERPNextError('备份写入需要 --confirm=BACKUP', 'backup_not_confirmed', 409)
    console.log(JSON.stringify(await createResticBackup(), null, 2))
  } else {
    throw new ERPNextError('mode 只能是 status、snapshots 或 backup', 'restic_bad_mode', 400)
  }
} catch (err) {
  if (err instanceof ERPNextError) {
    console.error(JSON.stringify({ ok: false, code: err.code, message: err.message }, null, 2))
    process.exitCode = 2
  } else {
    throw err
  }
}
