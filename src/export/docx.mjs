import { zip } from './zipwrite.mjs'

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

/* ---------- 配色：只有黑白灰 ----------
   近黑一档、灰两档、线两档，没有任何彩色。
   层级靠字重、字号和留白，不靠颜色 —— 所以也没有表头底纹和色块。
   图片版（public/js/pricecard.js）用的是同一组色值，两边别各改各的。 */
const INK = '1F2328'
const GRAY = '5C6166'
const FAINT = '8B9096'
const RULE = 'E7E9EB'
const RULE_STRONG = 'CACDD1'
// 价格和标题都用近黑：不再有「强调色」，重点靠加粗表达
const ACCENT = INK
const FONT = '微软雅黑'

/**
 * 调色板对外只读副本，给 scripts/checks/smoke.mjs 比对用。
 *
 * 为什么要把色值导出：冒烟测试以前把 'FDF1EA' / 'B33A22' 这两个旧色值写死在断言里，
 * 导出配色换成现在的靛蓝之后，测试还在查老色值，于是长期红着两项没人发现。
 * 让测试从这份定义里取色值，以后换配色只需要改这里。
 * 现在这份调色板必须是纯灰阶，冒烟测试会直接验这一点。
 */
export const DOCX_PALETTE = Object.freeze({ INK, GRAY, FAINT, RULE, RULE_STRONG, ACCENT })

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
  // 模型里 gain 是空串 = 「这一项不显示货币」（数量填了 0，或者游戏没配货币名）。
  // 这时候不能再把数字单独印出来：会留下一个孤零零的「5」，或者干脆一个「0」。
  // Excel 那边是整格留空，两边要一致。
  if (!item.gain) return ''
  if (item.gainAmount !== null && item.gainAmount !== undefined && item.gainAmount !== '') {
    const value = Number(item.gainAmount)
    if (Number.isFinite(value)) return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
  }
  // 兼容旧导出模型：只从「可得 货币 数量」里取最后的数量。
  const match = String(item.gain || '').match(/([0-9]+(?:\.[0-9]+)?)\s*$/)
  return match ? match[1] : ''
}

/** 表头写的是整组的货币名；这一项不是这个货币时，格里要自己带上名字 */
function gainCellText(item, groupCurrency) {
  const amount = gainAmountText(item)
  if (!amount) return ''
  const name = String(item.gainName || '').trim()
  return name && name !== String(groupCurrency || '').trim() ? `${name} ${amount}` : amount
}

function tableCell(content, width, { bold = false, color = INK, align = 'left' } = {}) {
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
        tableCell('服务项目', TABLE_WIDTHS[0], { bold: true, color: INK }),
        tableCell('单位 / 起订', TABLE_WIDTHS[1], { bold: true, color: INK, align: 'center' }),
        tableCell('价格', TABLE_WIDTHS[2], { bold: true, color: INK, align: 'right' }),
        tableCell(group.currency || '可得货币', TABLE_WIDTHS[3], { bold: true, color: INK, align: 'right' }),
        tableCell('说明', TABLE_WIDTHS[4], { bold: true, color: INK }),
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
        tableCell(tierLines, TABLE_WIDTHS[2], { bold: true, color: ACCENT, align: 'right' }),
        tableCell(gainCellText(it, group.currency), TABLE_WIDTHS[3], { color: GRAY, align: 'right' }),
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
  body.push(para('', { pPr: bottomRule(INK, 12) + spacing(0, 160, 240) }))
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
      para(run(g.name, { size: 24, bold: true, color: g.isOrphan ? GRAY : INK }), {
        pPr: spacing(gi === 0 ? 0 : 200, 60, 240) + bottomRule(RULE, 6),
      })
    )
    if (g.catNotice) body.push(...noticeParas(g.catNotice, '', { left: 360, size: 19, after: 120 }))
    body.push(priceTable(g))
    if (g.more > 0) {
      body.push(
        para(run(`还有 ${g.more} 项服务未展开`, { size: 18, color: FAINT, italic: true }), {
          pPr: spacing(40, 0, 240),
        })
      )
    }
  }
  if (model.hiddenCategories > 0) {
    body.push(
      para(run(`还有 ${model.hiddenCategories} 个大类未展开`, { size: 18, color: FAINT, italic: true }), {
        pPr: spacing(160, 0, 240),
      })
    )
  }
  body.push(para('', { pPr: bottomRule(RULE, 6) + spacing(320, 80, 240) }))
  if (model.contact) body.push(para(run(`联系：${model.contact}`, { size: 19, color: INK }), { pPr: spacing(0, 0, 260) }))
  if (model.footer) body.push(para(run(model.footer, { size: 17, color: FAINT }), { pPr: spacing(0, 0, 250) }))
  return documentPackage(body)
}

/**
 * 提示块：没有底纹，只有左边一道细灰竖线 —— 一眼看得出是提示，又不抢价格。
 * 每行一个段落（Word 不认 \n），相邻段落边框设置相同，Word 会自动接成一个整块。
 *
 * label 默认空着：这份文档是发给客户的，竖线块自己就说明白了，
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
    `<w:pBdr><w:left w:val="single" w:sz="12" w:space="10" w:color="${RULE_STRONG}"/></w:pBdr>` +
    `<w:ind w:left="${left}" w:right="120"/>` +
    extra
  // 标签单独一行，和图片版排法一致（同一个模型，两边看起来要一样）
  const out = label ? [para(run(label, { size: size - 2, bold: true, color: INK }), { pPr: box(spacing(80, 0, 240)) })] : []
  lines.forEach((ln, i) =>
    out.push(
      para(run(ln, { size, color: GRAY }), {
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
  body.push(para('', { pPr: bottomRule(INK, 12) + spacing(0, 160, 240) }))

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
      para(run(g.name, { size: 24, bold: true, color: g.isOrphan ? GRAY : INK }), {
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
            run(it.price, { size: 21, bold: true, color: INK, tab: true }),
          { pPr: rightTab('none') + spacing(40, 0, 264) }
        )
      )
      if (it.hint) {
        body.push(para(run(it.hint, { size: 18, color: GRAY }), { pPr: spacing(0, 0, 240) }))
      }
      // 可得货币：单独一行、加粗一档，说明文字截断也不会把它挤掉
      if (it.gain) {
        body.push(para(run(it.gain, { size: 19, bold: true, color: INK }), { pPr: spacing(20, 0, 240) }))
      }
      for (const note of (it.notes || []).filter(Boolean).slice(0, 3)) {
        body.push(para(run(note, { size: 18, color: GRAY }), { pPr: spacing(0, 0, 240) }))
      }
    }

    if (g.more > 0) {
      body.push(
        para(run(`…… 这个大类还有 ${g.more} 项，没在这里展开`, { size: 18, color: FAINT, italic: true }), {
          pPr: spacing(40, 0, 240),
        })
      )
    }
  })

  if (model.hiddenCategories > 0) {
    body.push(
      para(run(`…… 还有 ${model.hiddenCategories} 个大类没有列出`, { size: 18, color: FAINT, italic: true }), {
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
    body.push(para(run(model.footer, { size: 17, color: FAINT }), { pPr: spacing(0, 0, 250) }))
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
