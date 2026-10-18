import { db } from '../../core/db.mjs'

/**
 * SQLite 事务边界统一放在基础设施层。业务服务只描述操作，失败时由这里负责回滚。
 */
export function transaction(work) {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 保留原始业务错误，避免回滚异常遮住真正原因。
    }
    throw err
  }
}

