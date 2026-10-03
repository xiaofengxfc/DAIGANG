import zlib from 'node:zlib'

/* ============================================================
   极简 ZIP 打包（只写，不读）
   .docx 本质就是一个 zip，里面装几个 XML。
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

function zip(files) {
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

/* ============================================================
   OOXML 拼装
   ============================================================ */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const INK = '20242B'
const GRAY = '5F6B7A'
const CINNABAR = '5C54C7'
const RULE = 'E2E7ED'
const RULE_STRONG = 'CBD3DE'
const TINT = 'F1F2FF'
const FONT = '微软雅黑'

const PAGE_W = 11906 // A4 宽（twips）
const MARGIN = 1134 // 上下左右 2cm
const TEXT_W = PAGE_W - MARGIN * 2

function run(text, { size = 21, bold = false, color = INK, italic = false, tab = false } = {}) {
  const props = [
    `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}" w:cs="${FONT}"/>`,
    bold ? '<w:b/><w:bCs/>' : '',
    italic ? '<w:i/>' : '',
    `<w:color w:val="${color}"/>`,
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
  ].join('')
  return `<w:r><w:rPr>${props}</w:rPr>${tab ? '<w:tab/>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

function para(runs, { pPr = '' } = {}) {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`
}

const spacing = (before = 0, after = 0, line = 300) =>
  `<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/>`

const bottomRule = (color = RULE, sz = 8) =>
  `<w:pBdr><w:bottom w:val="single" w:sz="${sz}" w:space="6" w:color="${color}"/></w:pBdr>`

const rightTab = (leader = 'dot') => `<w:tabs><w:tab w:val="right" w:leader="${leader}" w:pos="${TEXT_W}"/></w:tabs>`

const tableBorders =
  `<w:tblBorders>` +
  `<w:top w:val="single" w:sz="6" w:color="${RULE_STRONG}"/>` +
  `<w:left w:val="single" w:sz="6" w:color="${RULE}"/>` +
  `<w:bottom w:val="single" w:sz="6" w:color="${RULE_STRONG}"/>` +
  `<w:right w:val="single" w:sz="6" w:color="${RULE}"/>` +
  `<w:insideH w:val="single" w:sz="4" w:color="${RULE}"/>` +
  `<w:insideV w:val="single" w:sz="4" w:color="${RULE}"/>` +
  `</w:tblBorders>`

const TABLE_WIDTHS = [3000, 1500, 1900, 1500, TEXT_W - 3000 - 1500 - 1900 - 1500]

function gainAmountText(item) {
  if (item.gainAmount !== null && item.gainAmount !== undefined && item.gainAmount !== '') {
    const value = Number(item.gainAmount)
    if (Number.isFinite(value)) return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
  }
  // 兼容旧导出模型：只从「可得 货币 数量」里取最后的数量。
  const match = String(item.gain || '').match(/([0-9]+(?:\.[0-9]+)?)\s*$/)
  return match ? match[1] : ''
}

function tableCell(content, width, { shade = '', bold = false, color = INK, align = 'left' } = {}) {
  const text = Array.isArray(content) ? content : [content]
  const paragraphs = text
    .filter((value) => value !== null && value !== undefined && String(value) !== '')
    .map((value) => {
      const pAlign = align === 'right' ? '<w:jc w:val="right"/>' : align === 'center' ? '<w:jc w:val="center"/>' : ''
      return para(run(String(value), { size: 18, bold, color }), { pPr: pAlign + spacing(0, 0, 230) })
    })
  const body = paragraphs.length ? paragraphs.join('') : para('', { pPr: spacing(0, 0, 230) })
  const props = [
    `<w:tcW w:w="${width}" w:type="dxa"/>`,
    '<w:vAlign w:val="center"/>',
    '<w:tcMar><w:top w:w="90" w:type="dxa"/><w:start w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:end w:w="110" w:type="dxa"/></w:tcMar>',
    shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '',
  ].join('')
  return `<w:tc><w:tcPr>${props}</w:tcPr>${body}</w:tc>`
}

function tableRow(cells, { header = false } = {}) {
  const trPr = `<w:cantSplit/>${header ? '<w:tblHeader/>' : ''}`
  return `<w:tr><w:trPr>${trPr}</w:trPr>${cells.join('')}</w:tr>`
}

function priceTable(group) {
  const rows = []
  rows.push(
    tableRow(
      [
        tableCell('服务项目', TABLE_WIDTHS[0], { shade: TINT, bold: true, color: CINNABAR }),
        tableCell('单位 / 起订', TABLE_WIDTHS[1], { shade: TINT, bold: true, color: CINNABAR, align: 'center' }),
        tableCell('价格', TABLE_WIDTHS[2], { shade: TINT, bold: true, color: CINNABAR, align: 'right' }),
        tableCell(group.currency || '可得货币', TABLE_WIDTHS[3], { shade: TINT, bold: true, color: CINNABAR, align: 'right' }),
        tableCell('说明', TABLE_WIDTHS[4], { shade: TINT, bold: true, color: CINNABAR }),
      ],
      { header: true }
    )
  )

  for (const it of group.items || []) {
    const unitStart = `${it.unit || ''}${it.minQty > 1 ? `，${it.minQty} 起` : ''}`
    const tierLines = Array.isArray(it.tierLines) && it.tierLines.length ? it.tierLines : [it.price || '']
    const notes = (it.notes || []).filter(Boolean)
    if (it.hint && !tierLines.length) tierLines.push(it.hint)
    rows.push(
      tableRow([
        tableCell(it.name || '', TABLE_WIDTHS[0]),
        tableCell(unitStart, TABLE_WIDTHS[1], { align: 'center' }),
        tableCell(tierLines, TABLE_WIDTHS[2], { color: CINNABAR, align: 'right' }),
        tableCell(gainAmountText(it), TABLE_WIDTHS[3], { color: GRAY, align: 'right' }),
        tableCell(notes, TABLE_WIDTHS[4], { color: GRAY }),
      ])
    )
  }

  const grid = TABLE_WIDTHS.map((width) => `<w:gridCol w:w="${width}"/>`).join('')
  const props = `<w:tblW w:w="${TEXT_W}" w:type="dxa"/><w:tblLayout w:type="fixed"/>${tableBorders}<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:start w:w="80" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:end w:w="80" w:type="dxa"/></w:tblCellMar>`
  return `<w:tbl><w:tblPr>${props}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`
}

function documentPackage(body) {
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="16838"/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="0" w:footer="0" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ])
}

/** 完整 A4 价目册：每个大类一张真表格，服务、单位起订、价格、货币和说明分列。 */
function buildFullDocx(model) {
  const body = []
  body.push(para(run(model.shopName, { size: 40, bold: true, color: INK }), { pPr: spacing(0, 40) }))
  const headRight = [model.subtitle, model.date].filter(Boolean).join('    ')
  body.push(
    para(run(model.title, { size: 22, color: GRAY }) + (headRight ? run(headRight, { size: 20, color: GRAY, tab: true }) : ''), {
      pPr: rightTab('none') + spacing(0, 20),
    })
  )
  body.push(para('', { pPr: bottomRule(CINNABAR, 18) + spacing(0, 160, 240) }))
  if (model.notice) body.push(...noticeParas(model.notice))

  let lastGame = null
  for (const [gi, g] of (model.groups || []).entries()) {
    const gameHead = Boolean(model.multiGame && g.gameName && g.gameName !== lastGame)
    if (gameHead) {
      lastGame = g.gameName
      body.push(
        para(run(g.gameName, { size: 34, bold: true, color: INK }), {
          pPr: spacing(gi === 0 ? 0 : 320, 40, 240) + bottomRule(RULE_STRONG, 12),
        })
      )
    }
    if (g.gameNotice) {
      const label = gameHead || !g.gameName ? '' : g.gameName
      body.push(...noticeParas(g.gameNotice, label))
    }
    body.push(
      para(run(g.name, { size: 24, bold: true, color: g.isOrphan ? GRAY : CINNABAR }), {
        pPr: spacing(gi === 0 ? 0 : 200, 60, 240) + bottomRule(RULE, 6),
      })
    )
    if (g.catNotice) body.push(...noticeParas(g.catNotice, '', { left: 360, size: 19, after: 120 }))
    body.push(priceTable(g))
    if (g.more > 0) {
      body.push(
        para(run(`还有 ${g.more} 项服务未展开`, { size: 18, color: GRAY, italic: true }), {
          pPr: spacing(40, 0, 240),
        })
      )
    }
  }
  if (model.hiddenCategories > 0) {
    body.push(
      para(run(`还有 ${model.hiddenCategories} 个大类未展开`, { size: 18, color: GRAY, italic: true }), {
        pPr: spacing(160, 0, 240),
      })
    )
  }
  body.push(para('', { pPr: bottomRule(RULE, 6) + spacing(320, 80, 240) }))
  if (model.contact) body.push(para(run(`联系：${model.contact}`, { size: 19, color: INK }), { pPr: spacing(0, 0, 260) }))
  if (model.footer) body.push(para(run(model.footer, { size: 17, color: GRAY }), { pPr: spacing(0, 0, 250) }))
  return documentPackage(body)
}

/**
 * 提示块：浅色底 + 左边一道靛蓝竖线，就是应用里那个提示条的样子。
 * 每行一个段落（Word 不认 \n），相邻段落边框设置相同，Word 会自动接成一个整块。
 *
 * label 默认空着：这份文档是发给客户的，浅色块自己就说明白了，
 * 不用在上面再压一个「公告」的标题。
 * 大类的提示会传更小的 size 和更大的 left —— 层级低一级，缩进一格。
 */
function noticeParas(notice, label = '', { left = 160, size = 20, after = 140 } = {}) {
  const lines = String(notice || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length) return []
  const box = (extra) =>
    `<w:shd w:val="clear" w:color="auto" w:fill="${TINT}"/>` +
    `<w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="${CINNABAR}"/></w:pBdr>` +
    `<w:ind w:left="${left}" w:right="120"/>` +
    extra
  // 标签单独一行，和图片版排法一致（同一个模型，两边看起来要一样）
  const out = label ? [para(run(label, { size: size - 2, bold: true, color: CINNABAR }), { pPr: box(spacing(80, 0, 240)) })] : []
  lines.forEach((ln, i) =>
    out.push(
      para(run(ln, { size, color: INK }), {
        pPr: box(spacing(0, i === lines.length - 1 ? after : 0, 250)),
      })
    )
  )
  return out
}

/**
 * 把导出模型渲染成一份 .docx。
 * 排版用的是「菜单式点线」：服务名 …… 价格。朴素、好读、打印也好看。
 */
export function buildDocx(model) {
  if (model?.full || model?.format === 'full') return buildFullDocx(model)
  const body = []

  /* —— 抬头 —— */
  body.push(
    para(run(model.shopName, { size: 40, bold: true, color: INK }), {
      pPr: spacing(0, 40),
    })
  )
  const headRight = [model.subtitle, model.date].filter(Boolean).join('    ')
  body.push(
    para(
      run(model.title, { size: 22, color: GRAY }) + (headRight ? run(headRight, { size: 20, color: GRAY, tab: true }) : ''),
      { pPr: rightTab('none') + spacing(0, 20) }
    )
  )
  body.push(para('', { pPr: bottomRule(CINNABAR, 18) + spacing(0, 160, 240) }))

  /* —— 公告：只面向一个游戏时放在最上方 —— */
  // 抬头那行已经写了游戏名，提示块也够显眼，所以不带任何标题文字
  if (model.notice) {
    body.push(...noticeParas(model.notice))
  }

  /* —— 大类 —— */
  let lastGame = null
  model.groups.forEach((g, gi) => {
    // 导出多个游戏时，插一条游戏小标题（比大类高一级）
    const gameHead = Boolean(model.multiGame && g.gameName && g.gameName !== lastGame)
    if (gameHead) {
      lastGame = g.gameName
      body.push(
        para(run(g.gameName, { size: 34, bold: true, color: INK }), {
          pPr: spacing(gi === 0 ? 0 : 320, 40, 240) + bottomRule(RULE_STRONG, 12),
        })
      )
    }

    // 合并导出时，游戏的提示跟在它的第一个大类上面（小标题里已经写了游戏名就不重复了）
    if (g.gameNotice) {
      // 只在没印游戏小标题时才用游戏名当标签 —— 不再出现「公告」两个字
      const label = gameHead || !g.gameName ? '' : g.gameName
      body.push(...noticeParas(g.gameNotice, label))
    }

    body.push(
      para(run(g.name, { size: 24, bold: true, color: g.isOrphan ? GRAY : CINNABAR }), {
        pPr: spacing(gi === 0 ? 0 : 200, 60, 240) + bottomRule(RULE, 6),
      })
    )

    // 大类自己的提示：排在名字下面、服务项上面，缩进一格、字小一号
    if (g.catNotice) {
      body.push(...noticeParas(g.catNotice, '', { left: 360, size: 19, after: 120 }))
    }

    for (const it of g.items) {
      body.push(
        para(
          run(it.name, { size: 21, color: INK }) +
            run(it.price, { size: 21, bold: true, color: CINNABAR, tab: true }),
          { pPr: rightTab('dot') + spacing(40, 0, 264) }
        )
      )
      if (it.hint) {
        body.push(para(run(it.hint, { size: 18, color: CINNABAR }), { pPr: spacing(0, 0, 240) }))
      }
      // 可得货币：单独一行、加粗一档，说明文字截断也不会把它挤掉
      if (it.gain) {
        body.push(para(run(it.gain, { size: 19, bold: true, color: GRAY }), { pPr: spacing(20, 0, 240) }))
      }
      for (const note of (it.notes || []).filter(Boolean).slice(0, 3)) {
        body.push(para(run(note, { size: 18, color: GRAY }), { pPr: spacing(0, 0, 240) }))
      }
    }

    if (g.more > 0) {
      body.push(
        para(run(`…… 这个大类还有 ${g.more} 项，没在这里展开`, { size: 18, color: GRAY, italic: true }), {
          pPr: spacing(40, 0, 240),
        })
      )
    }
  })

  if (model.hiddenCategories > 0) {
    body.push(
      para(run(`…… 还有 ${model.hiddenCategories} 个大类没有列出`, { size: 18, color: GRAY, italic: true }), {
        pPr: spacing(160, 0, 240),
      })
    )
  }

  /* —— 页脚 —— */
  body.push(para('', { pPr: bottomRule(RULE, 6) + spacing(320, 80, 240) }))
  if (model.contact) {
    body.push(para(run(`联系：${model.contact}`, { size: 19, color: INK }), { pPr: spacing(0, 0, 260) }))
  }
  if (model.footer) {
    body.push(para(run(model.footer, { size: 17, color: GRAY }), { pPr: spacing(0, 0, 250) }))
  }

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="16838"/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="0" w:footer="0" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ])
}
