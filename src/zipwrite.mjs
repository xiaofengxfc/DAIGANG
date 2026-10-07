import zlib from 'node:zlib'

/* ============================================================
   极简 ZIP 打包（只写，不读）
   .docx / .xlsx 本质都是一个 zip，里面装几个 XML。
   用 node:zlib 的 deflateRaw 压缩，压不动就退回 store。
   ============================================================ */

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

export function zip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const crc = crc32(data)
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const useDeflate = deflated.length < data.length
    const out = useDeflate ? deflated : data
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x21, 12) // mod date = 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(out.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBuf, out)
    central.push({ nameBuf, crc, compSize: out.length, size: data.length, method, offset })
    offset += local.length + nameBuf.length + out.length
  }

  const centralStart = offset
  for (const c of central) {
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(20, 6)
    h.writeUInt16LE(0x0800, 8)
    h.writeUInt16LE(c.method, 10)
    h.writeUInt16LE(0, 12)
    h.writeUInt16LE(0x21, 14)
    h.writeUInt32LE(c.crc, 16)
    h.writeUInt32LE(c.compSize, 20)
    h.writeUInt32LE(c.size, 24)
    h.writeUInt16LE(c.nameBuf.length, 28)
    h.writeUInt16LE(0, 30)
    h.writeUInt16LE(0, 32)
    h.writeUInt16LE(0, 34)
    h.writeUInt16LE(0, 36)
    h.writeUInt32LE(0, 38)
    h.writeUInt32LE(c.offset, 42)
    chunks.push(h, c.nameBuf)
  }

  const centralSize = chunks
    .slice(chunks.length - central.length * 2)
    .reduce((n, b) => n + b.length, 0)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)

  return Buffer.concat(chunks)
}
