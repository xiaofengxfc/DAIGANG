/**
 * 测试用的应用实例：起一个干净库的实例，跑完能干净地关掉。
 *
 * scripts/smoke-run.mjs（接口冒烟）和 scripts/ui-smoke.mjs（界面冒烟）共用这一份，
 * 两边的数据目录安检、端口分配、收尾逻辑就不会各写一套。
 *
 * 关键顺序：XFC_DATA_DIR 必须在 import 应用之前设好——src/config.mjs 是在模块加载时
 * 读环境变量的，import 之后再设就晚了（会落到默认的 data/ 上去，那是真数据）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 这些脚本干的第一件事就是**递归删掉数据目录**，所以目录得先过安检。
 *
 * 两条都过才算安全：
 *   1. 不在项目根目录或它的上级（含盘符根——注意不能简单地 d + path.sep，
 *      盘符根本身就带分隔符，拼出来是两个反斜杠，反而放行了）；
 *   2. 要么在系统临时目录里，要么目录名以 data-smoke 开头
 *      （只该碰自己那类一次性目录；想放别处就用临时目录）。
 *
 * 返回空串表示安全，否则返回不能用的理由。
 */
export function unsafeDataDirReason(dir) {
  if (dir === ROOT) return '它就是项目根目录'
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
  if (ROOT.startsWith(prefix)) return '它是项目根目录的上级'
  const inTemp = dir.startsWith(path.resolve(os.tmpdir()) + path.sep)
  if (!inTemp && !path.basename(dir).startsWith('data-smoke')) return '目录名不以 data-smoke 开头，也不在系统临时目录里'
  return ''
}

/** 解析并检查数据目录；不安全就抛错（调用方决定怎么退出） */
export function resolveDataDir(explicit) {
  const dir = path.resolve(explicit || process.env.XFC_SMOKE_DATA_DIR || path.join(ROOT, 'data-smoke-run'))
  const reason = unsafeDataDirReason(dir)
  if (reason) {
    const err = new Error(
      `拒绝把「${dir}」当作测试数据目录：${reason}。\n` +
        '  这个目录会被整个删掉重建，换个名字（data-smoke-xxx）或用 XFC_SMOKE_DATA_DIR 指到临时目录。'
    )
    err.unsafeDataDir = true
    throw err
  }
  return dir
}

let started = false

/**
 * 起一个干净实例。返回 { base, port, dataDir, stop }。
 * 端口交给系统分配（listen(0)），不跟正在运行的 8787 抢。
 */
export async function startTestApp({ dataDir } = {}) {
  if (started) throw new Error('一个进程里只能起一个测试实例（配置是模块加载时读的，第二次会复用第一个库）')
  started = true

  const dir = resolveDataDir(dataDir)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  process.env.XFC_DATA_DIR = dir
  process.env.XFC_LOCAL = '1'
  process.env.XFC_MEDIA_EXECUTOR_AUTOSTART = '0' // 别让测试顺手拉起 Python 执行器
  process.env.XFC_MEDIA_SCHEDULER_INTERVAL_MS = '0' // 关掉定时发布轮询，测试里不需要
  // 视觉后端也关掉自启、并且换一个端口：测试实例的数据目录是临时的，
  // 里面的 venv 不存在，本来就起不来；但万一它退到系统 Python 上找到了依赖，
  // 就会去抢 5410 —— 那台端口上很可能正跑着你自己那份实例的 sidecar。
  process.env.XFC_VISION_AUTOSTART = '0'
  process.env.XFC_VISION_PORT = '5419'
  // 「只截图」那条路每按一次 F2 就是一帧，上限放宽一点，免得测试连按几下把自己挤掉
  process.env.XFC_SCREEN_FRAME_LIMIT = '16'

  const { createApplication } = await import('../../src/server/app.mjs')
  const { db } = await import('../../src/db.mjs')

  const app = createApplication()
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = app.server.address()

  const stop = async () => {
    await new Promise((resolve) => app.server.close(resolve))
    try {
      db.close()
    } catch {
      /* 关不掉就算了，进程马上要退 */
    }
  }

  return { base: `http://127.0.0.1:${port}`, port, dataDir: dir, stop }
}

/**
 * 往这个测试实例里塞一帧「识别截图」的暂存帧，返回它的 token。
 *
 * 给冒烟测试用：正常路径上这帧是 recognizeScreenOnce() 抓屏后存的，那需要真的
 * 有游戏窗口和 OCR 引擎 —— 测试里不可能有。这里直接调真实的那份 stash 模块
 * （同一个进程、同一份模块实例，所以服务器那边真的取得到），把「取帧 → 压缩
 * → 上传」这条链路测完整。
 */
export async function stashTestFrame(session = 'smoke-frame') {
  const { stashFrame } = await import('../../src/screen-stash.mjs')
  // 1×1 的合法 PNG：够真实到能被 <img> 解码
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  )
  return stashFrame({ session, stage: 'bag', buf: png, width: 1, height: 1 })
}
