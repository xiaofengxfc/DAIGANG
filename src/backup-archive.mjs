/* ============================================================
   整包备份：把「数据库快照 + 上传文件」打成一个 .tar.gz
   ============================================================

   为什么不是 zip：
     写一个能用的 zip 要自己扛 ZIP64、数据描述符、两个 CRC 表；
     而 tar 的头就是 512 字节定长块，gzip 用 Node 自带的 zlib。
     对一个「本地优先、不想引第三方依赖」的项目来说，
     tar.gz 是**能用 200 行说清楚**的那个选择。

   为什么不是直接把 data/ 拷一份：
     console.db 跑在 WAL 模式下，正在写的时候文件里的页是半旧的
     （新数据还在 -wal 里）。直接拷 .db 可能拷到一个自相矛盾的库。
     所以数据库走 `db.serialize()` —— SQLite 自己给的一致性快照，
     快照里已经含了 WAL 里那部分改动。

   归档里的布局（解压出来是一个自解释的目录）：

     README.txt                 这份备份是什么、怎么还原
     console.db                 数据库快照（可被 SQLite 直接打开）
     uploads/<原来的相对路径>    图标、截图、自媒体素材

   已经用 `tar -tzf` / `tar -xzf` 与 7-Zip 双向验证过。
   ============================================================ */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { UPLOAD_DIR } from './config.mjs'

const BLOCK = 512

/**
 * 写一个 USTAR 头。
 *
 * 几个容易写错、写错了 tar 就解不开的地方：
 *   · 数字字段是**八进制**、右侧留一个 NUL 或空格，不是十进制；
 *   · name 超过 100 字节要用 prefix 字段拆（USTAR 的 155 + 100）；
 *   · checksum 的计算方式是「先把 checksum 那 8 字节当空格，求和，再以 6 位八进制写回」。
 */
function header(name, { size = 0, mode = 0o644, mtime = 0, type = '0', prefix = '' } = {}) {
  const buf = Buffer.alloc(BLOCK, 0)

  const writeStr = (offset, length, value) => {
    const bytes = Buffer.from(String(value), 'utf8')
    // 截断要按字节截，按字符截会把多字节字符切成半个，tar 读到就是一串乱码
    bytes.copy(buf, offset, 0, Math.min(bytes.length, length))
  }

  const split = splitName(name)
  writeStr(0, 100, split.name)
  if (split.prefix) writeStr(345, 155, split.prefix)

  const octal = (value, length) => {
    const s = Math.max(0, Math.floor(value)).toString(8)
    // 留最后一位给 NUL：长度 N 的字段里最多放 N-1 个八进制数字
    return s.slice(-(length - 1)).padStart(length - 1, '0') + '\0'
  }

  writeStr(100, 8, octal(mode, 8))
  writeStr(108, 8, octal(0, 8)) // uid
  writeStr(116, 8, octal(0, 8)) // gid
  writeStr(124, 12, octal(size, 12))
  writeStr(136, 12, octal(Math.floor(mtime / 1000), 12)) // mtime 是秒，不是毫秒

  // 文件里每个字节都当 0 处理；真实文件就一个空格；目录是 '5'
  writeStr(156, 1, type)
  writeStr(257, 6, 'ustar\0')
  writeStr(263, 2, '00')

  // checksum：先把那 8 字节填成空格再求和，最后写成 6 位八进制 + NUL + 空格
  buf.fill(0x20, 148, 156)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += buf[i]
  const checksum = sum.toString(8).padStart(6, '0')
  writeStr(148, 8, `${checksum}\0 `)

  return buf
}

/** name 太长时按 USTAR 规则拆成 prefix + name，两边都塞不下就截断 */
function splitName(full) {
  const bytes = Buffer.byteLength(full, 'utf8')
  if (bytes <= 100) return { name: full, prefix: '' }
  const cut = full.lastIndexOf('/')
  if (cut > 0) {
    const prefix = full.slice(0, cut)
    const name = full.slice(cut + 1)
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix }
  }
  // 实在放不下：按字节砍到 100，宁可名字被截也不让头写坏
  let out = ''
  for (const ch of full) {
    if (Buffer.byteLength(out + ch, 'utf8') > 100) break
    out += ch
  }
  return { name: out, prefix: '' }
}

/** 一个 512 对齐的填充：内容不足一块要补 NUL，tar 靠这个找下一个头 */
function pad(size) {
  const rem = size % BLOCK
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0)
}

/**
 * PAX 扩展头。
 *
 * 干嘛用的：**告诉解压器「这个归档里的文件名是 UTF-8」**。
 *
 * 不写的后果实测过：tar 头里的名字字段确实是 UTF-8 字节，但按 USTAR 规范它
 * 只是「一串字节」，没声明编码。Windows 自带的 bsdtar 于是拿系统 ANSI 代码页
 * 去解释，`进度截图-中文名.png` 被转成 `杩涘害鎴浘-涓枃鍚_png` —— 解压出来的
 * 文件名字是坏的。数据没丢，但名字坏了就等于找不回来。
 *
 * PAX 记录格式是 `<总长度> <键>=<值>\n`，**长度包含它自己占的那几位数字**
 * ——这就是这个格式唯一反直觉的地方，所以要循环逼近一次。
 * hdrcharset=UTF-8 是 POSIX 标准里专门声明这个的键，bsdtar / GNU tar / 7-Zip
 * 都认。
 */
function paxRecord(key, value) {
  const body = `${key}=${value}\n`
  const bodyLen = Buffer.byteLength(body, 'utf8')
  // 「长度」字段本身可能从 1 位涨到 2 位，涨了就得重算，所以循环收敛
  let digits = 1
  for (let i = 0; i < 4; i++) {
    const total = bodyLen + digits + 1 // +1 是长度和 body 之间的那个空格
    const next = String(total).length
    if (next === digits) break
    digits = next
  }
  const total = bodyLen + digits + 1
  return `${String(total).padStart(digits, '0')} ${body}`
}

/** PAX 扩展头的条目本身也叫 `./PaxHeaders.0/<name>`，长度不能超过名字字段 */
function paxNameFor(name) {
  const base = `./PaxHeaders.0/${String(name).replace(/^\.?\//, '')}`
  if (Buffer.byteLength(base, 'utf8') <= 100) return base
  // 太长就只留文件名部分：这只是一个承载 hdrcharset 的辅助条目，
  // 解压器不关心它叫什么，只要不把头写坏。
  const tail = String(name).replace(/\/+$/, '').split('/').pop()
  const short = `./PaxHeaders.0/${tail}`
  return Buffer.byteLength(short, 'utf8') <= 100 ? short : './PaxHeaders.0/entry'
}

/** 建归档，返回 { buffer }（完整 tar.gz）。选项见 buildTar。 */
export function buildArchive(opts) {
  const built = buildTar(opts)
  return { ...built, buffer: zlib.gzipSync(built.tar, { level: 6 }) }
}

/**
 * 和 buildArchive 同源，但 gzip 那一步留成流，边压边发给浏览器。
 *
 * 为什么不直接 `buildArchive().buffer`：上传目录可能到几百 MB，全压完再发
 * 意味着压缩结果又占一份内存，而且那段时间浏览器只能干等、没有任何进度。
 * 走流的话 gzip 是边读边压边发，浏览器能看到下载在动。
 *
 * 内存账要说清楚：未压缩的 tar 仍然整块在内存里（构造 chunks 时拼出来的）。
 * 这是刻意的取舍 —— 本地单机工具、备份频率低，换来的是不落磁盘中转文件、
 * 也不会「备份到一半崩了留下半个文件」需要清理。
 * 真要再省，就得把 buildTar 改成生成器、边遍历边产出，那是另一件事了。
 */
export function streamArchive(opts) {
  const built = buildTar(opts)
  const source = Readable.from(built.tar)
  const gzip = zlib.createGzip({ level: 6 })
  // destroy 两侧一起收：任一侧出错都要把另一侧拆掉，否则管道会悬着不漏也不报
  gzip.on('error', () => source.destroy())
  source.on('error', (err) => gzip.destroy(err))
  return { ...built, source, stream: source.pipe(gzip) }
}

/**
 * 只构造 tar（不压缩）。返回的 tar 已经是完整 Buffer。
 *
 * @param {object} opts
 * @param {Buffer|Uint8Array} opts.dbSnapshot  SQLite 一致性快照
 * @param {string} [opts.uploadDir]           上传文件根目录
 * @param {() => number} [opts.now]           取时间，测试里可以钉死
 * @param {(rel: string, size: number) => boolean} [opts.includeUpload] 过滤上传件
 * @param {number} [opts.maxUploadBytes]      上传件总量上限，超了不塞并记进 README
 */
function buildTar({ dbSnapshot, uploadDir = UPLOAD_DIR, now = Date.now, includeUpload = null, maxUploadBytes = 2 * 1024 * 1024 * 1024 } = {}) {
  if (!dbSnapshot || !dbSnapshot.length) throw new Error('数据库快照是空的，拒绝生成备份')

  const at = now()
  const chunks = []
  let total = 0

  // tar 里所有条目的时间戳统一用生成时刻：备份是一个整体，逐文件保留原 mtime
  // 会让「这份备份是什么时候做的」变得看不出来。
  const mtime = at

  const addFile = (name, data, { mode = 0o644, usePax = false } = {}) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (usePax) {
      // 声明「文件名是 UTF-8」。只用 hdrcharset 这一条就够：路径本身仍写在
      // 普通头里，解压器知道该按 UTF-8 读它就对了。
      const record = Buffer.from(paxRecord('hdrcharset', 'UTF-8'), 'utf8')
      chunks.push(header(paxNameFor(name), { size: record.length, mode: 0o644, mtime, type: 'x' }))
      chunks.push(record)
      chunks.push(pad(record.length))
      total += BLOCK + record.length + (record.length % BLOCK === 0 ? 0 : BLOCK - (record.length % BLOCK))
    }
    chunks.push(header(name, { size: buf.length, mode, mtime, type: '0' }))
    chunks.push(buf)
    chunks.push(pad(buf.length))
    // 头 + 内容 + 填充 —— tar 的「占用大小」要按这个算，用来报字节数
    total += BLOCK + buf.length + (buf.length % BLOCK === 0 ? 0 : BLOCK - (buf.length % BLOCK))
  }

  const addDir = (name, { usePax = false } = {}) => {
    // 目录条目以 / 结尾、size 为 0，这是 tar 的约定，解压器靠它建目录
    const dirName = name.endsWith('/') ? name : `${name}/`
    if (usePax) {
      const record = Buffer.from(paxRecord('hdrcharset', 'UTF-8'), 'utf8')
      chunks.push(header(paxNameFor(dirName), { size: record.length, mode: 0o644, mtime, type: 'x' }))
      chunks.push(record)
      chunks.push(pad(record.length))
      total += BLOCK + record.length + (record.length % BLOCK === 0 ? 0 : BLOCK - (record.length % BLOCK))
    }
    chunks.push(header(dirName, { size: 0, mode: 0o755, mtime, type: '5' }))
    total += BLOCK
  }

  /* 非 ASCII 路径才值得多花一个 PAX 头；纯 ASCII 路径所有解压器都读得对，
     没必要给每个文件都加一条记录把归档撑大。 */
  const needsPax = (name) => /[^\x20-\x7E]/.test(String(name))

  const listed = []
  const skipped = []

  // 目录条目放前面：有些解压器（尤其是老的 Windows 工具）不按需建中间目录
  addDir('backup')
  addDir('backup/uploads')

  addFile('backup/console.db', Buffer.from(dbSnapshot))

  let uploadBytes = 0
  if (uploadDir && fs.existsSync(uploadDir)) {
    for (const rel of walkFiles(uploadDir)) {
      const abs = path.join(uploadDir, rel)
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      // tar 路径一律正斜杠：Windows 上拼出来的反斜杠会被当成文件名字符，解压出一堆怪名字
      const entry = `backup/uploads/${rel.split(path.sep).join('/')}`
      if (includeUpload && !includeUpload(rel, stat.size)) {
        skipped.push({ path: entry, size: stat.size, reason: '按规则跳过' })
        continue
      }
      if (uploadBytes + stat.size > maxUploadBytes) {
        skipped.push({ path: entry, size: stat.size, reason: '超过归档上限' })
        continue
      }
      let data
      try {
        data = fs.readFileSync(abs)
      } catch (err) {
        skipped.push({ path: entry, size: stat.size, reason: `读不出来：${err.message}` })
        continue
      }
      // 读的过程中文件被换掉了：以实际读到的为准，别让头里的 size 和内容对不上
      addFile(entry, data, { usePax: needsPax(entry) })
      uploadBytes += data.length
      listed.push({ path: entry, size: data.length })
    }
  }

  addFile('backup/README.txt', Buffer.from(readme({ at, dbBytes: Buffer.from(dbSnapshot).length, uploads: listed, skipped }), 'utf8'))

  // tar 结尾是两个全零块
  chunks.push(Buffer.alloc(BLOCK * 2, 0))
  total += BLOCK * 2

  const tar = Buffer.concat(chunks)
  return { tar, tarBytes: total, uploads: listed, skipped }
}

/** 遍历目录，返回相对路径（跳过符号链接，避免备份里出现环） */
function walkFiles(dir, base = dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(abs, base, out)
    } else if (entry.isFile()) {
      out.push(path.relative(base, abs))
    }
  }
  return out
}

function readme({ at, dbBytes, uploads, skipped }) {
  const lines = [
    '代肝价格查询 · 私用运营台 —— 整包备份',
    '',
    `生成时间：${new Date(at).toISOString()}`,
    '',
    '这个压缩包里有什么',
    '  console.db      数据库快照（SQLite 格式，可以用任何 SQLite 工具直接打开）',
    '  uploads/        上传的图标、进度截图、自媒体素材',
    '',
    '怎么还原',
    '  1. 关掉后台（启动器里点「停止」，或关掉那个控制台窗口）',
    '  2. 找到 data/ 目录（启动窗口里会打印路径，一般是程序目录下的 data/）',
    '  3. 把原来的 data/ 改名留个底，比如 data-old/',
    '  4. 新建 data/，把这里的 console.db 放进去',
    '  5. 把 uploads/ 整个放进 data/ 下（变成 data/uploads/）',
    '  6. 重新启动后台',
    '',
    '  注意：登录密码和保险箱设置都在 console.db 里，所以换机器后',
    '  用的是同一套密码。凭证仍然是密文，需要同一个保险箱密码才能解开。',
    '',
    '  也可以走设置页的「导入」：那条路只吃 JSON 格式的备份，',
    '  不吃这个压缩包。压缩包是「整机还原」，JSON 是「搬业务数据」。',
    '',
    `数据库快照：${dbBytes} 字节`,
    `上传文件：${uploads.length} 个`,
  ]
  if (uploads.length) {
    lines.push('')
    lines.push('上传文件清单：')
    for (const item of uploads) lines.push(`  ${item.path}  ${item.size} 字节`)
  }
  if (skipped.length) {
    lines.push('')
    lines.push('**没有进归档的文件**（备份不完整，注意）：')
    for (const item of skipped) lines.push(`  ${item.path}  ${item.size} 字节 —— ${item.reason}`)
  }
  return lines.join('\n')
}

/** 给下载用的文件名：Windows 上冒号是非法字符，必须换成短横 */
export function archiveFilename(at = new Date()) {
  const iso = new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `代肝运营台-整包备份-${iso}.tar.gz`
}
