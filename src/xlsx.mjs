import { zip } from './zipwrite.mjs'

/* ============================================================
   价格表 → 一个 .xlsx（真表格，不是图片）
   ============================================================

   和图片 / Word 一样，都从同一个「导出模型」出，内容一致：
     · 一行一个价格：配了阶梯价的，一档一行，单价是**真数字**（能排序、能求和）
     · 大类、单位、起订、档位、可得货币数量、说明各占一列
     · 首行冻结 + 自动筛选，服务项多了直接筛，不用翻
     · 多个游戏各一张工作表，不混在一起

   配色仍然只有黑白灰，和图片、Word 同一组色值：
   表头不用底纹，只靠加粗和一条细灰下划线区分。
   ============================================================ */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/* ---------- 配色：纯灰阶（xlsx 的色值要 ARGB，所以是 8 位） ---------- */
const INK = 'FF1F2328'
const GRAY = 'FF5C6166'
const FAINT = 'FF8B9096'
const RULE_STRONG = 'FFCACDD1'
const FONT = '微软雅黑'

/** 调色板对外只读副本，给 scripts/smoke.mjs 比对用（必须是纯灰阶） */
export const XLSX_PALETTE = Object.freeze({ INK, GRAY, FAINT, RULE_STRONG })

/* ---------- 表格结构 ---------- */
const COLUMNS = [
  { title: '大类', width: 16 },
  { title: '服务项目', width: 26 },
  { title: '单位', width: 8 },
  { title: '起订', width: 8 },
  { title: '档位', width: 14 },
  { title: '单价(元)', width: 11 },
  { title: '可得货币', width: 10 },
  { title: '可得数量', width: 10 },
  { title: '大类说明', width: 24 },
  { title: '说明', width: 42 },
]
const COL_COUNT = COLUMNS.length
const LAST_COL = (() => {
  let n = COL_COUNT
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
})()

/* ---------- 单元格样式索引（对应下面 styles.xml 里的 cellXfs 顺序） ---------- */
const S = {
  text: 0, // 普通文字，自动换行、顶对齐
  header: 1, // 表头：加粗 + 细灰下划线
  money: 2, // 单价：加粗 + ¥ 数字格式，右对齐
  title: 3, // 店名
  sub: 4, // 抬头那一行小字 / 提示
  center: 5, // 单位、起订、档位
  number: 6, // 可得数量
  category: 7, // 大类名，加粗
  faint: 8, // 弱化的说明（还有 N 项这种）
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;¥&quot;#,##0.00"/></numFmts>` +
  `<fonts count="4">` +
  `<font><sz val="11"/><color rgb="${INK}"/><name val="${FONT}"/><charset val="134"/></font>` +
  `<font><b/><sz val="11"/><color rgb="${INK}"/><name val="${FONT}"/><charset val="134"/></font>` +
  `<font><b/><sz val="16"/><color rgb="${INK}"/><name val="${FONT}"/><charset val="134"/></font>` +
  `<font><sz val="10"/><color rgb="${FAINT}"/><name val="${FONT}"/><charset val="134"/></font>` +
  `</fonts>` +
  `<fills count="2">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `</fills>` +
  `<borders count="3">` +
  `<border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left/><right/><top/><bottom style="thin"><color rgb="${RULE_STRONG}"/></bottom><diagonal/></border>` +
  `<border><left/><right/><top/><bottom style="thin"><color rgb="${INK}"/></bottom><diagonal/></border>` +
  `</borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="9">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`

const qty = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

/** 一档阶梯价写成「1-5层」「6层以上」这种 */
function rangeText(tier, unit) {
  const lo = qty(tier.minQty)
  if (tier.maxQty === null || tier.maxQty === undefined || tier.maxQty === '') return `${lo}${unit}以上`
  const hi = qty(tier.maxQty)
  if (String(lo) === String(hi)) return `${lo}${unit}`
  return `${lo}-${hi}${unit}`
}

function cellXml(ref, value, style) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`
}

function rowXml(index, cells) {
  const body = cells.filter(Boolean).join('')
  return body ? `<row r="${index}">${body}</row>` : `<row r="${index}"/>`
}

/** 把「一行的值 + 每列样式」排成一行 */
function makeRow(index, values, styles) {
  const cells = values.map((v, i) => cellXml(`${colName(i + 1)}${index}`, v, styles[i]))
  return rowXml(index, cells)
}

function colName(n) {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

const sheetName = (raw) => {
  const cleaned = String(raw || '')
    .replace(/[\\/:*?[\]]/g, '')
    .trim()
    .slice(0, 28)
  return cleaned || '价目表'
}

/** 把导出模型拆成「一张工作表一个游戏」 */
function planSheets(model) {
  const groups = (model.groups || []).filter((g) => (g.items || []).length)
  const order = []
  const byGame = new Map()
  for (const g of groups) {
    const key = g.gameName || ''
    if (!byGame.has(key)) {
      byGame.set(key, [])
      order.push(key)
    }
    byGame.get(key).push(g)
  }
  if (!order.length) return [{ name: '价目表', groups: [], notice: model.notice || '' }]

  const used = new Set()
  return order.map((key, i) => {
    const base = sheetName(key || (order.length === 1 ? model.subtitle || '价目表' : '通用项'))
    let name = base
    let n = 2
    while (used.has(name)) name = `${base}(${n++})`.slice(0, 31)
    used.add(name)

    const list = byGame.get(key)
    // 公告：这一份只面向一个游戏时，模型的 notice 就是它的（图片和 Word 也是这样）
    let notice = ''
    if (model.notice && (order.length === 1 || key === model.noticeGameName)) notice = model.notice
    else notice = list.find((g) => g.gameNotice)?.gameNotice || ''
    return { name, groups: list, notice, first: i === 0 }
  })
}

/** 一个工作表的 XML */
function sheetXml(sheet, model) {
  const head = []
  head.push(makeRow(1, [model.shopName], [S.title]))
  const sub = [model.title, model.subtitle, model.date].filter(Boolean).join('    ')
  head.push(makeRow(2, [sub], [S.sub]))
  let headRows = 2
  if (sheet.notice) {
    for (const line of String(sheet.notice).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      headRows++
      head.push(makeRow(headRows, [line], [S.sub]))
    }
  }
  headRows++
  head.push(makeRow(headRows, [''], [S.text])) // 空一行再上表头

  const headerRow = headRows + 1
  head.push(makeRow(headerRow, COLUMNS.map((c) => c.title), COLUMNS.map(() => S.header)))

  const dataRows = []
  for (const g of sheet.groups) {
    const items = g.items || []
    items.forEach((it, idx) => {
      const catNotice = idx === 0 ? g.catNotice || '' : ''
      const notes = (it.notes || []).filter(Boolean).join('\n')
      const gainName = it.gain ? g.currency || '' : ''
      const gainQty = it.gain ? it.gainAmount : null
      const tiers = Array.isArray(it.tiers) ? it.tiers.filter(Boolean) : []
      if (tiers.length) {
        for (const t of tiers) {
          dataRows.push({
            values: [g.name, it.name, it.unit, t.minQty, rangeText(t, it.unit), t.unitPrice, gainName, gainQty, catNotice, notes],
          })
        }
      } else {
        dataRows.push({
          values: [g.name, it.name, it.unit, it.minQty, '', it.basePrice, gainName, gainQty, catNotice, notes],
        })
      }
    })
    if (g.more > 0) {
      dataRows.push({ values: ['', `…… 这个大类还有 ${g.more} 项未展开`, '', '', '', '', '', '', '', ''], faint: true })
    }
  }
  if (model.hiddenCategories > 0 && sheet.first) {
    dataRows.push({ values: ['', `…… 还有 ${model.hiddenCategories} 个大类没有列出`, '', '', '', '', '', '', '', ''], faint: true })
  }

  const styleOf = (colIndex) => [S.category, S.text, S.center, S.center, S.center, S.money, S.center, S.number, S.text, S.text][colIndex]

  const body = []
  let r = headerRow
  for (const row of dataRows) {
    r++
    body.push(makeRow(r, row.values, row.values.map((_, i) => (row.faint ? S.faint : styleOf(i)))))
  }
  const lastRow = r

  const cols = COLUMNS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')

  const dimension = `<dimension ref="A1:${LAST_COL}${lastRow}"/>`
  const sheetViews =
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>`
  const sheetFormatPr = `<sheetFormatPr defaultRowHeight="15"/>`
  const sheetData = `<sheetData>${head.join('')}${body.join('')}</sheetData>`
  const autoFilter = `<autoFilter ref="A${headerRow}:${LAST_COL}${lastRow}"/>`

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    dimension +
    sheetViews +
    sheetFormatPr +
    `<cols>${cols}</cols>` +
    sheetData +
    autoFilter +
    `</worksheet>`
  )
}

/**
 * 把导出模型渲染成一个 .xlsx。
 * 一行一个价格档，单价是真数字；多个游戏各一张工作表。
 */
export function buildXlsx(model) {
  const sheets = planSheets(model)

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets></workbook>`

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ]
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, model) }))

  return zip(files)
}
