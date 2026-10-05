import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, Edit3, RefreshCw, Upload } from 'lucide-react'
import { api } from './lib/api.js'
import { fmtDateTime } from './lib/formatters.js'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDialog } from './app/confirm.jsx'
import Drawer from './app/drawer.jsx'
import { Field, SelectInput, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { ensureVaultReady, useVaultState } from './vault-gate.jsx'
import { refreshVault } from '../public/js/vaultgate.js'
import { downloadBlob } from '../public/js/pricecard.js'

/* ============================================================
   设置（React 版）
   ============================================================

   原来是 public/js/views/settings.js：店铺信息、两个密码、屏幕识别、
   安装选项、备份恢复、安全须知、关于，一页到底。迁移时守住：

   - 文案一字不改（含 OCR 那段说明、安装卡上的状态句、危险动作的确认词）；
   - 表单还是那套 DOM（.field / .lbl / .inp / .hint / .err），只是换成受控组件；
   - 保险箱状态仍旧读 public/js/vaultgate.js 那一份，弹窗换成 React 的
     （client/vault-gate.jsx），这样顶栏的锁扣和这里的说法永远一致；
   - 安装进度照旧轮询（前两次 700ms，之后 1200ms 退避），但卸载时必须停：
     旧版是命令式 DOM，节点没了轮询自己就断了，React 里得自己收。

   页头按钮放在页内（这一页其实没有页头动作，旧版的「修改 / 改密码 / 导出」
   都在各自的条目行上）。
   ============================================================ */

const iconProps = (size = 14) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

/** 引擎排序：越靠前越优先。和后端 src/ocr.mjs 的探测链同一个顺序 */
const OCR_ENGINE_ORDER = ['umi', 'paddleocr', 'rapidocr', 'tesseract', 'windows']

const SHOP_FORM_ID = 'settings-shop-form'
const PASSWORD_FORM_ID = 'settings-password-form'
const VAULT_PASSWORD_FORM_ID = 'settings-vault-password-form'
const ICON_FORM_ID = 'settings-icon-template-form'

/** 每个字段一个固定 id：提交时把焦点送回第一个出错的那格（旧引擎就是这么做的） */
const SHOP_IDS = {
  business_name: 'settings-shop-business-name',
  admin_name: 'settings-shop-admin-name',
  contact: 'settings-shop-contact',
  quote_footer: 'settings-shop-quote-footer',
  quote_valid_days: 'settings-shop-quote-valid-days',
  default_note: 'settings-shop-default-note',
}

const PASSWORD_IDS = {
  current: 'settings-password-current',
  next: 'settings-password-next',
  confirm: 'settings-password-confirm',
}

const VAULT_PASSWORD_IDS = {
  current: 'settings-vault-password-current',
  next: 'settings-vault-password-next',
}

export default function SettingsPage({ onReload, reloadKey }) {
  const vault = useVaultState()
  const [settings, setSettings] = useState(null)
  const [counts, setCounts] = useState({})
  const [ocr, setOcr] = useState(null)
  const [actor, setActor] = useState('')
  const [error, setError] = useState('')
  const importRef = useRef(null)

  const load = useCallback(async () => {
    // 保险箱状态先对齐：这一行要按 configured / unlocked 决定显示「去设置」还是「改密码」
    await refreshVault()
    try {
      const [settingsRes, countsRes, ocrRes, meRes] = await Promise.all([
        api.get('/api/settings'),
        api.get('/api/backup/counts'),
        // 没装 OCR 的机器上这个接口本来就探不到东西：失败不该把整页拖垮（旧版 catch 成 null）
        api.get('/api/ocr/status').catch(() => null),
        // 旧版从 ctx.app.state.me 里取「本次登录」的操作人，React 这边自己问一次
        api.get('/api/auth/me').catch(() => null),
      ])
      setSettings(settingsRes || {})
      setCounts(countsRes || {})
      setOcr(ocrRes)
      setActor((meRes && meRes.actor) || '')
      setError('')
    } catch (err) {
      setError((err && err.message) || String(err))
      setSettings((current) => current || {})
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const reload = useCallback(() => {
    load()
    if (onReload) onReload()
  }, [load, onReload])

  /** 「重新检测」：带 probe=1，真的去敲一次本机 OCR 服务 */
  const probeOcr = useCallback(async () => {
    try {
      const fresh = await api.get('/api/ocr/status', { probe: 1 })
      toast(
        fresh.available ? `检测完成，现在用 ${fresh.engine_name || fresh.engine}` : '还是没检测到可用的引擎',
        fresh.available ? 'ok' : 'err',
        4200
      )
      setOcr(fresh)
    } catch (err) {
      toastErr(err)
    }
  }, [])

  /** 装完引擎 / 存完图标模板之后只重取识别状态，不整页刷新（旧版的 onRefreshDone） */
  const refreshOcr = useCallback(async () => {
    const fresh = await api.get('/api/ocr/status').catch(() => null)
    setOcr((current) => fresh || current)
  }, [])

  const openShop = useCallback(async () => {
    const saved = await openShopForm(settings || {})
    if (saved) reload()
  }, [settings, reload])

  const resetAll = useCallback(async () => {
    const ok = await confirmDialog({
      title: '清空全部业务数据？',
      message: '订单、进度、收款、客户、凭证、价格表、游戏都会被删掉。登录密码和保险箱密码保留。这个操作不可撤销，建议先导出一份备份。',
      confirmLabel: '清空',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.post('/api/system/reset', { confirm: 'CLEAR' })
      toast('已清空', 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }, [reload])

  const importBackup = useCallback(async (event) => {
    const input = event.target
    const file = input.files && input.files[0]
    if (!file) return
    let payload
    try {
      payload = JSON.parse(await file.text())
    } catch {
      toastErr('这个文件不是合法的 JSON')
      input.value = ''
      return
    }
    const ok = await confirmDialog({
      title: '导入备份会覆盖现在的全部数据',
      message: `备份导出于 ${payload.exported_at ? fmtDateTime(payload.exported_at) : '未知时间'}。导入后现有的订单、客户、凭证、价格表全部被替换，而且所有设备都要重新登录。`,
      confirmLabel: '确认覆盖',
      tone: 'danger',
    })
    if (!ok) {
      input.value = ''
      return
    }
    try {
      const r = await api.post('/api/backup/import', { payload, confirm: 'REPLACE' })
      toast(`导入完成：${(r.imported && r.imported.orders) || 0} 单`, 'ok', 4000)
      // 后端把所有会话都销毁了：留一眼提示的时间再自己刷新（和旧版一致）
      setTimeout(() => location.reload(), 1200)
    } catch (err) {
      toastErr(err)
    } finally {
      input.value = ''
    }
  }, [])

  const LAN = location.hostname !== '127.0.0.1' && location.hostname !== 'localhost'

  return (
    <div className="settings-page">
      <header className="settings-page__head">
        <div>
          <span className="refactor-eyebrow">本机设置</span>
          <h2>设置</h2>
          <p>店铺信息、密码、备份与安全</p>
        </div>
      </header>

      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}

      {settings === null ? (
        <div className="refactor-loading"><span /><span /><span /></div>
      ) : (
        <>
          <section className="panel">
            <div className="panel__body"><SectionHead title="店铺信息" /></div>
            <div className="itemlist">
              <Row
                title="招牌名 / 称呼"
                desc={`${settings.business_name || '未设置'} · 操作人 ${settings.admin_name || '未设置'}`}
                action={<button className="btn btn--sm" type="button" onClick={openShop}><Edit3 {...iconProps(14)} />修改</button>}
              />
              <Row title="联系方式" desc={settings.contact || '未填写'} />
              <Row title="报价单默认有效期" desc={`${settings.quote_valid_days || 7} 天`} />
            </div>
          </section>

          <section className="panel">
            <div className="panel__body"><SectionHead title="安全" /></div>
            <div className="itemlist">
              <Row
                title="登录密码"
                desc="手机和电脑共用这一个。改完其他设备会退出。"
                action={<button className="btn btn--sm" type="button" onClick={() => openPasswordForm()}>改密码</button>}
              />
              <Row
                title="保险箱密码"
                desc={
                  vault.configured
                    ? vault.unlocked
                      ? '当前已解开。改密码会重新加密所有凭证。'
                      : '当前已锁定。'
                    : '还没设置。设了之后游戏账号密码才能加密入库。'
                }
                action={
                  <div className="tbl__acts">
                    {vault.configured ? (
                      <button className="btn btn--sm" type="button" onClick={() => openVaultPasswordForm()}>改密码</button>
                    ) : (
                      <button
                        className="btn btn--sm btn--primary"
                        type="button"
                        onClick={async () => {
                          const ready = await ensureVaultReady()
                          if (ready) {
                            toast('保险箱已就绪', 'ok')
                            reload()
                          }
                        }}
                      >
                        去设置
                      </button>
                    )}
                  </div>
                }
                extra={
                  vault.configured
                    ? <span className={`tag${vault.unlocked ? ' tag--jade' : ' tag--amber'}`}>{vault.unlocked ? '已解开' : '已锁定'}</span>
                    : <span className="tag tag--oxblood">未设置</span>
                }
              />
              <Row title="保险箱加密" desc="AES-256-GCM，密钥由你的保险箱密码用 scrypt 推导，只存在于内存，不写进任何文件。" />
            </div>
          </section>

          <OcrPanel st={ocr} onProbe={probeOcr} onRefreshDone={refreshOcr} />

          <section className="panel">
            <div className="panel__body"><SectionHead title="数据" /></div>
            <div className="itemlist">
              <Row
                title="当前数据量"
                desc={`${counts.orders || 0} 张订单 · ${counts.customers || 0} 位客户 · ${counts.credentials || 0} 条凭证 · ${counts.services || 0} 个服务项 · ${counts.games || 0} 个游戏`}
              />
              <Row
                title="导出一份备份"
                desc="下载一个 JSON 文件，含全部业务数据。凭证在文件里仍然是密文，换台电脑要用同一个保险箱密码才能解开。"
                action={<button className="btn btn--sm" type="button" onClick={() => exportBackup().catch(toastErr)}><Download {...iconProps(14)} />导出</button>}
              />
              <Row
                title="从备份恢复"
                desc="会用备份内容覆盖现在的全部数据。"
                action={
                  <div className="tbl__acts">
                    <button className="btn btn--sm" type="button" onClick={() => importRef.current && importRef.current.click()}><Upload {...iconProps(14)} />导入</button>
                    <input ref={importRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={importBackup} />
                  </div>
                }
              />
              <Row
                title="清空业务数据"
                desc="清掉订单、客户、凭证、价格表和游戏，保留登录密码和保险箱设置。不可撤销。"
                action={<button className="btn btn--sm btn--danger" type="button" onClick={resetAll}>清空</button>}
              />
            </div>
          </section>

          <section className="panel">
            <div className="panel__body"><SectionHead title="安全须知" note="值得花一分钟读完" /></div>
            <div className="panel__body" style={{ paddingTop: '0' }}>
              <ul className="empty__steps" style={{ maxWidth: '70ch' }}>
                <li><span className="n">1</span><span>数据全部存在这台电脑的 data/ 目录里，不会上传到任何地方。把整个文件夹拷走就是完整备份。</span></li>
                <li><span className="n">2</span><span>用手机通过局域网访问时走的是普通 HTTP，同一 WiFi 下的其他人理论上能抓包看到你输入的密码。建议只在自家/可信 WiFi 下用手机访问，或者启动时加 --local 只允许本机。</span></li>
                <li><span className="n">3</span><span>游戏登录凭证是加密的，但保险箱密码一旦忘记就真的解不开——没有后门。请记在密码管理器里。</span></li>
                <li><span className="n">4</span><span>优先让客户扫码登录。能不存密码，就不存密码。</span></li>
                <li><span className="n">5</span><span>定期导出备份。硬盘坏了、系统重装了，SQLite 文件不会自己回来。</span></li>
              </ul>
              {LAN ? <div className="note note--warn" style={{ marginTop: 'var(--sp-4)' }}>{`你现在是透过局域网访问的（${location.host}）。请确认这个 WiFi 是你信得过的。`}</div> : null}
            </div>
          </section>

          <section className="panel">
            <div className="panel__body"><SectionHead title="关于" /></div>
            <div className="panel__body" style={{ paddingTop: '0' }}>
              {/* 旧版这里用的是 div.kv（不是 dl），保持一样的结构 */}
              <div className="kv">
                <dt>程序</dt>
                <dd>代肝价格查询 · 私用运营台</dd>
                <dt>版本</dt>
                <dd>v1.0.0</dd>
                <dt>运行方式</dt>
                <dd>Node.js 内置 http + SQLite，零第三方依赖</dd>
                <dt>存储</dt>
                <dd><span className="mono sm">data/console.db</span></dd>
                <dt>本次登录</dt>
                <dd>{actor || '—'}</dd>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/* ---------------- 小件：区块标题 / 条目行 ---------------- */

function SectionHead({ title, note, children }) {
  return (
    <div className="sechead">
      <h3>{title}</h3>
      {note ? <span className="sechead__note">{note}</span> : null}
      {children}
    </div>
  )
}

/** 设置页的一行：标题（+ 状态标签）+ 说明 + 右侧动作 */
function Row({ title, desc, action, extra }) {
  return (
    <div className="item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="item__main">
        <div className="item__title">
          {title}
          {extra || null}
        </div>
        {desc ? <div className="tbl__meta" style={{ marginTop: '2px' }}>{desc}</div> : null}
      </div>
      {action || null}
    </div>
  )
}

/* ============================================================
   屏幕识别：引擎状态 + 图标模板 + 安装选项
   引擎是本机程序，装了就用、没装就往下退，探测链写在后端 src/ocr.mjs 里。
   ============================================================ */

function OcrPanel({ st, onProbe, onRefreshDone }) {
  const [probing, setProbing] = useState(false)

  // 探测失败时旧版给的是一句「后端可能还没重启到新版」，不是空白
  if (!st) {
    return (
      <section className="panel">
        <div className="panel__body">
          <SectionHead title="屏幕识别" />
          <div className="note">拿不到识别状态（后端可能还没重启到新版）。</div>
        </div>
      </section>
    )
  }

  const engines = [...(st.engines || [])].sort((a, b) => OCR_ENGINE_ORDER.indexOf(a.id) - OCR_ENGINE_ORDER.indexOf(b.id))
  const tpl = st.templates || { items: [], missing: [] }

  return (
    <section className="panel">
      <div className="panel__body">
        <div className="sechead">
          <h3>屏幕识别</h3>
          <span className="sechead__note">{st.available ? `当前引擎：${st.engine_name || st.engine}` : '这台机器上还没有可用的 OCR'}</span>
          <button
            className="btn btn--sm"
            type="button"
            data-loading={probing ? '1' : undefined}
            onClick={async () => {
              setProbing(true)
              try {
                await onProbe()
              } finally {
                setProbing(false)
              }
            }}
          >
            <RefreshCw {...iconProps(14)} />重新检测
          </button>
        </div>
      </div>
      <div className="itemlist">
        {engines.map((eng) => <EngineRow key={eng.id} eng={eng} preferred={st.engine} />)}
      </div>
      <div className="panel__body" style={{ paddingTop: '0' }}>
        <div className="note">识别用到的东西全部在这台电脑上跑，截图不出本机。按顺序试：Umi-OCR（装了并打开 HTTP 服务最好用）→ PaddleOCR-json / RapidOCR-json（解压到 tools\ocr\ 或设环境变量）→ Tesseract → Windows 自带。装了哪个用哪个，没装就往下退，不会因为缺一个就用不了。</div>
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <div className="tbl__meta">{`图标模板（认出「哪个图标是星声/体力/贝币」靠它们）：共 ${tpl.items.length} 个`}</div>
          <div className="cluster" style={{ marginTop: '4px', flexWrap: 'wrap' }}>
            {tpl.items.map((it) => (
              <span key={it.key} className={`tag${it.from === 'custom' ? ' tag--jade' : ' tag--muted'}`}>{`${it.key}${it.from === 'custom' ? ' · 自备' : ''}`}</span>
            ))}
            {tpl.missing && tpl.missing.length ? <span className="tag tag--amber">{`缺 ${tpl.missing.join('、')}`}</span> : null}
          </div>
          <div className="cluster" style={{ marginTop: 'var(--sp-3)' }}>
            <button className="btn btn--sm" type="button" onClick={() => openIconTemplateForm(st, onRefreshDone)}><Upload {...iconProps(14)} />自备一个图标模板</button>
            <span className="dim tiny">换了游戏版本、图标变了样子时用：给一张顶栏截图 + 图标所在的方框，程序当场抠出来存下。</span>
          </div>
          <InstallSection onChanged={onRefreshDone} />
        </div>
      </div>
    </section>
  )
}

function EngineRow({ eng, preferred }) {
  const live = eng.id === preferred
  return (
    <div className="item" style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="item__main">
        <div className="item__title">
          {eng.name}
          {live ? <span className="tag tag--jade">正在用</span> : eng.available ? <span className="tag tag--jade">可用</span> : <span className="tag tag--muted">未安装</span>}
          {eng.license ? <span className="dim tiny" style={{ marginLeft: '6px' }}>{eng.license}</span> : null}
        </div>
        <div className="tbl__meta" style={{ marginTop: '2px' }}>{eng.available ? eng.note || '已就绪' : eng.note || ''}</div>
        {!eng.available && eng.install ? <div className="tbl__meta" style={{ marginTop: '2px', opacity: '.75' }}>{`怎么装：${eng.install}`}</div> : null}
      </div>
    </div>
  )
}

/* ============================================================
   安装选项：一键把本地 OCR 引擎装到 tools\ocr\
   后端负责下载官方 Release + 解压 + 落位（见 src/ocr-install.mjs），
   这里只负责发起、轮询进度、装完自检。
   ============================================================ */

function fileSizeText(n) {
  if (!n) return ''
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

function shortSize(s) {
  // 后端给的是「约 70MB 下载 / 展开约 95MB」这种整句，直接显示
  return String(s || '').replace(/^约\s*/, '').split(' ')[0] || '自动'
}

function idleStatusText(option) {
  return option.installed ? `已装好：${option.path || '探测到了'}` : option.blocked_reason || ''
}

function InstallSection({ onChanged }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api.get('/api/ocr/install')
      setData({ options: r.options || [], extractor: r.extractor || {} })
      setError('')
      setLoaded(true)
    } catch (err) {
      setData(null)
      setError((err && err.message) || String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 装完 / 自检完：重查一遍选项，再让上面的识别面板也重取状态
  const handleChanged = useCallback(() => {
    load()
    onChanged()
  }, [load, onChanged])

  const extractor = data ? data.extractor : {}
  const options = data ? data.options : []
  const rest = options.filter((o) => !o.installed)
  const installed = options.filter((o) => o.installed)

  return (
    <div style={{ marginTop: 'var(--sp-4)' }}>
      <div className="cluster" style={{ marginBottom: '6px' }}>
        <strong className="sm">安装选项</strong>
        <span className="tiny dim">装完自动就能用，图标模板不用重做</span>
        <div style={{ flex: '1' }} />
        <button className="btn btn--sm btn--quiet" type="button" onClick={load}><RefreshCw {...iconProps(13)} />{loaded ? '重新查' : '查一下'}</button>
      </div>
      <div className="stack stack--tight">
        {error ? (
          <div className="note note--alert">{`拿不到安装选项：${error}`}</div>
        ) : busy || data === null ? (
          <div className="tiny dim">正在查安装选项…</div>
        ) : (
          <>
            <span className={extractor.can_auto ? 'tone-jade' : 'tone-amber'}>
              {extractor.can_auto
                ? `解压器：${extractor.bin || extractor.kind}（能解 .7z，可以直接自动安装）`
                : extractor.hint || extractor.note || '这台机器上没有能解 .7z 的解压器'}
            </span>
            {rest.length
              ? <div className="tiny dim">还没装的：</div>
              : <div className="tiny dim">这几个都已经装好了 —— 上面「图标模板」那块可以自备模板，引擎不用再装。</div>}
            {rest.map((o) => <InstallOptionCard key={o.id} option={o} onChanged={handleChanged} />)}
            {installed.length ? (
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <div className="tiny dim">已经装好的：</div>
                {installed.map((o) => <InstallOptionCard key={o.id} option={o} onChanged={handleChanged} />)}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/** 一个安装选项一张卡 */
function InstallOptionCard({ option, onChanged }) {
  const [statusText, setStatusText] = useState(() => idleStatusText(option))
  const [statusTone, setStatusTone] = useState('')
  const [bar, setBar] = useState(null)
  const [log, setLog] = useState('')
  const [installing, setInstalling] = useState(false)
  const [checking, setChecking] = useState(false)

  // 卸载就收摊：清掉还在等的定时器，把等着的 sleep 直接放行，
  // 轮询下一轮醒来看到 alive=false 就自己退出（不再往卸载掉的组件写状态）
  const alive = useRef(true)
  const sleepers = useRef(new Map())

  useEffect(() => {
    alive.current = true
    const pending = sleepers.current
    return () => {
      alive.current = false
      for (const [id, resolve] of pending) {
        window.clearTimeout(id)
        resolve()
      }
      pending.clear()
    }
  }, [])

  // 父级重查了一次（option 换了新对象）就把这张卡刷回初始样子：
  // 旧版是 replaceChildren 重建卡片，状态自然归零
  useEffect(() => {
    setStatusText(idleStatusText(option))
    setStatusTone('')
    setBar(null)
    setLog('')
  }, [option])

  const sleep = (ms) => new Promise((resolve) => {
    const id = window.setTimeout(() => {
      sleepers.current.delete(id)
      resolve()
    }, ms)
    sleepers.current.set(id, resolve)
  })

  async function watch(jobId) {
    let dots = 0
    let last = null
    for (;;) {
      if (!alive.current) return last
      let r
      try {
        r = await api.get('/api/ocr/install/status', { job: jobId })
      } catch (err) {
        if (alive.current) setStatusText(`查进度失败：${(err && err.message) || err}`)
        break
      }
      if (!alive.current) return last
      const j = r.job
      last = j
      const pct = j.state === 'downloading' ? Number(j.percent) || 0 : j.state === 'extracting' ? 100 : 0
      setBar(Math.max(4, pct))
      const elapsed = Math.round(j.elapsed_ms / 1000)
      setStatusText(
        `${j.step}${j.state === 'downloading' && j.total ? ` · ${fileSizeText(j.received)} / ${fileSizeText(j.total)}（${j.percent}%）` : ''}` +
          ` · 已用 ${elapsed}s` +
          (j.state === 'downloading' && j.percent > 2 && elapsed > 6 ? ` · 预计还要 ${Math.max(1, Math.round((elapsed * (100 - j.percent)) / j.percent / 60))} 分钟` : '')
      )
      if (j.log && j.log.length) setLog(j.log.join('\n'))
      if (j.state === 'done' || j.state === 'error') {
        if (j.state === 'done') {
          setStatusText(j.result && j.result.available ? `装好了 —— 现在用的是 ${j.result.name}` : '文件装好了，但探测没认出来')
        } else {
          setStatusText(`装失败：${j.error}`)
        }
        break
      }
      dots++
      await sleep(dots < 3 ? 700 : 1200)
    }
    return last
  }

  async function checkHealth() {
    setChecking(true)
    try {
      const r = await api.post('/api/ocr/install/health', { engine: option.id })
      if (!alive.current) return
      setStatusText(r.ok ? `自检：${r.verdict}` : `自检不了：${r.error}`)
      // 旧版这里直接把 className 改成 'tiny tone-…'，连 dim 一起去掉
      setStatusTone(r.ok && !r.crashed ? 'jade' : 'amber')
    } catch (err) {
      toastErr(err)
    } finally {
      setChecking(false)
    }
  }

  async function install() {
    setInstalling(true)
    try {
      const r = await api.post('/api/ocr/install', { engine: option.id })
      if (!alive.current) return
      setBar(4)
      toast(`开始安装 ${option.name}，下载可能要几分钟`, 'ok', 4200)
      const last = await watch(r.job.id)
      if (!alive.current) return
      if (last && last.state === 'done' && last.result && last.result.available) {
        toast(`${option.name} 装好了，识别会自动用它`, 'ok', 5200)
        onChanged()
      } else if (last && last.state === 'error') {
        toast(`安装失败：${last.error}`, 'err', 8000)
      } else {
        toast('装完了，但探测没认出来 —— 看下面日志', 'err', 8000)
        onChanged()
      }
    } catch (err) {
      toastErr(err)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="install">
      <div className="install__head">
        <span className="install__name">{option.name}</span>
        {option.installed ? <span className="tag tag--jade">已装好</span> : <span className="tag tag--muted">未安装</span>}
        <span className="tiny dim">{option.license}</span>
        <div style={{ flex: '1' }} />
        {option.installed ? null : <span className="tiny dim">{option.size}</span>}
      </div>
      <div className="tiny dim" style={{ marginTop: '2px' }}>{option.note}</div>
      <div className="cluster" style={{ gap: '6px', flexWrap: 'wrap' }}>
        {option.installed ? (
          <button className="btn btn--sm" type="button" data-loading={checking ? '1' : undefined} onClick={checkHealth}><Check {...iconProps(14)} />自检一下</button>
        ) : option.can_auto ? (
          <button className="btn btn--sm btn--primary" type="button" disabled={installing} data-loading={installing ? '1' : undefined} onClick={install}><Download {...iconProps(14)} />{`自动安装（${shortSize(option.size)}）`}</button>
        ) : (
          <a className="btn btn--sm" href={option.release_page} target="_blank" rel="noreferrer noopener"><Download {...iconProps(14)} />去下载页</a>
        )}
        {!option.can_auto && !option.installed ? <span className="tiny dim">{option.blocked_reason || '需要手动装'}</span> : null}
        {option.env_key ? <span className="tiny dim">{`装到别处也可以在环境变量里设 ${option.env_key}`}</span> : null}
      </div>
      <div className="install__bar" hidden={bar === null}>
        <div className="install__fill" style={{ width: bar === null ? undefined : `${bar}%` }} />
      </div>
      <div className={`tiny${statusTone ? ` tone-${statusTone}` : ' dim'}`}>{statusText}</div>
      <div className="install__log" hidden={!log}>{log}</div>
    </div>
  )
}

/* ============================================================
   四个抽屉表单
   ============================================================ */

function openShopForm(values) {
  return openOverlay((close) => <ShopForm values={values} close={close} />, 'settings-shop-form')
}

function openPasswordForm() {
  return openOverlay((close) => <PasswordForm close={close} />, 'settings-password-form')
}

function openVaultPasswordForm() {
  return openOverlay((close) => <VaultPasswordForm close={close} />, 'settings-vault-password-form')
}

function openIconTemplateForm(st, onDone) {
  return openOverlay((close) => <IconTemplateForm st={st} onDone={onDone} close={close} />, 'settings-icon-template-form')
}

function ShopForm({ values, close }) {
  const [form, setForm] = useState(() => ({
    business_name: values.business_name || '',
    admin_name: values.admin_name || '',
    contact: values.contact || '',
    quote_footer: values.quote_footer || '',
    // 旧引擎给 number 字段的默认值就是 settings.quote_valid_days || 7
    quote_valid_days: String(values.quote_valid_days || 7),
    default_note: values.default_note || '',
  }))
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!String(form.business_name).trim()) next.business_name = '请填写店铺 / 招牌名'
    if (form.quote_valid_days.trim() !== '' && !Number.isFinite(Number(form.quote_valid_days))) next.quote_valid_days = '请填数字'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(SHOP_IDS[Object.keys(next)[0]])?.focus()
      return
    }
    setBusy(true)
    setServerError('')
    try {
      const saved = await api.patch('/api/settings', {
        business_name: form.business_name,
        admin_name: form.admin_name,
        contact: form.contact,
        quote_footer: form.quote_footer,
        quote_valid_days: form.quote_valid_days.trim() === '' ? '' : Number(form.quote_valid_days),
        default_note: form.default_note,
      })
      toast('已保存', 'ok')
      close(saved)
    } catch (err) {
      setServerError((err && err.message) || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="店铺信息"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>取消</button>
          <div style={{ flex: '1' }} />
          <button className="btn btn--primary" type="submit" form={SHOP_FORM_ID} disabled={busy} data-loading={busy ? '1' : undefined}>保存</button>
        </>
      }
    >
      <form id={SHOP_FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <Field label="店铺 / 招牌名" required htmlFor={SHOP_IDS.business_name} error={errors.business_name} hint="显示在页面标题和报价单抬头">
              <TextInput id={SHOP_IDS.business_name} value={form.business_name} onChange={set('business_name')} aria-invalid={errors.business_name ? 'true' : undefined} />
            </Field>
            <Field label="怎么称呼你" half htmlFor={SHOP_IDS.admin_name} hint="保险箱审计里的操作人">
              <TextInput id={SHOP_IDS.admin_name} value={form.admin_name} onChange={set('admin_name')} />
            </Field>
            <Field label="联系方式" half htmlFor={SHOP_IDS.contact}>
              <TextInput id={SHOP_IDS.contact} value={form.contact} onChange={set('contact')} placeholder="例：微信 xiaofeng" />
            </Field>
            <Field label="报价单页脚" htmlFor={SHOP_IDS.quote_footer}>
              <TextInput id={SHOP_IDS.quote_footer} value={form.quote_footer} onChange={set('quote_footer')} placeholder="例：价格随版本更新，以最新报价为准" />
            </Field>
            <Field label="报价默认有效期" half suffix="天" htmlFor={SHOP_IDS.quote_valid_days} error={errors.quote_valid_days}>
              <TextInput id={SHOP_IDS.quote_valid_days} numeric value={form.quote_valid_days} onChange={set('quote_valid_days')} aria-invalid={errors.quote_valid_days ? 'true' : undefined} />
            </Field>
            <Field label="开单默认备注" half htmlFor={SHOP_IDS.default_note}>
              <TextInput id={SHOP_IDS.default_note} value={form.default_note} onChange={set('default_note')} />
            </Field>
          </div>
          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

function PasswordForm({ close }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!form.current) next.current = '请填写当前密码'
    if (!form.next) next.next = '请填写新密码'
    if (!form.confirm) next.confirm = '请填写再输一次新密码'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(PASSWORD_IDS[Object.keys(next)[0]])?.focus()
      return
    }
    setBusy(true)
    setServerError('')
    try {
      // 「两次输入的新密码不一致」由后端判（旧版也没在前端比对），原样显示在下面
      await api.post('/api/auth/password', { current: form.current, next: form.next, confirm: form.confirm })
      toast('登录密码已改', 'ok')
      close(true)
    } catch (err) {
      setServerError((err && err.message) || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="改登录密码"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>取消</button>
          <div style={{ flex: '1' }} />
          <button className="btn btn--primary" type="submit" form={PASSWORD_FORM_ID} disabled={busy} data-loading={busy ? '1' : undefined}>改密码</button>
        </>
      }
    >
      <form id={PASSWORD_FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="note">改完之后，其他设备上的登录会全部退出。</div>
          <div className="formgrid">
            <Field label="当前密码" required htmlFor={PASSWORD_IDS.current} error={errors.current}>
              <input id={PASSWORD_IDS.current} className="inp" type="password" autoComplete="current-password" value={form.current} onChange={(event) => set('current')(event.target.value)} />
            </Field>
            <Field label="新密码" required htmlFor={PASSWORD_IDS.next} hint="至少 6 位" error={errors.next}>
              <input id={PASSWORD_IDS.next} className="inp" type="password" autoComplete="new-password" value={form.next} onChange={(event) => set('next')(event.target.value)} />
            </Field>
            <Field label="再输一次新密码" required htmlFor={PASSWORD_IDS.confirm} error={errors.confirm}>
              <input id={PASSWORD_IDS.confirm} className="inp" type="password" autoComplete="new-password" value={form.confirm} onChange={(event) => set('confirm')(event.target.value)} />
            </Field>
          </div>
          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

function VaultPasswordForm({ close }) {
  const [form, setForm] = useState({ current: '', next: '' })
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!form.current) next.current = '请填写当前保险箱密码'
    if (!form.next) next.next = '请填写新保险箱密码'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(VAULT_PASSWORD_IDS[Object.keys(next)[0]])?.focus()
      return
    }
    setBusy(true)
    setServerError('')
    try {
      const r = await api.post('/api/vault/password', { current: form.current, next: form.next })
      toast(`已重新加密 ${r.reencrypted} 条凭证`, 'ok')
      // 重新加密之后保险箱状态（configured / unlocked）可能变了，重新对齐一次
      await refreshVault()
      close(true)
    } catch (err) {
      setServerError((err && err.message) || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="改保险箱密码"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>取消</button>
          <div style={{ flex: '1' }} />
          <button className="btn btn--primary" type="submit" form={VAULT_PASSWORD_FORM_ID} disabled={busy} data-loading={busy ? '1' : undefined}>改密码</button>
        </>
      }
    >
      <form id={VAULT_PASSWORD_FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="note note--warn">改密码会把数据库里所有凭证重新加密一遍。过程中不要关掉启动窗口。如果中途断电，旧密文可能解不开——改之前建议先导出一份备份。</div>
          <div className="formgrid">
            <Field label="当前保险箱密码" required htmlFor={VAULT_PASSWORD_IDS.current} error={errors.current}>
              <input id={VAULT_PASSWORD_IDS.current} className="inp" type="password" autoComplete="current-password" value={form.current} onChange={(event) => set('current')(event.target.value)} />
            </Field>
            <Field label="新保险箱密码" required htmlFor={VAULT_PASSWORD_IDS.next} hint="至少 8 位，不能纯数字" error={errors.next}>
              <input id={VAULT_PASSWORD_IDS.next} className="inp" type="password" autoComplete="new-password" value={form.next} onChange={(event) => set('next')(event.target.value)} />
            </Field>
          </div>
          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

/** 自备图标模板：给一张顶栏截图 + 一个方框，后端当场抠出图标本体存下 */
function IconTemplateForm({ st, onDone, close }) {
  const resources = st.resources || []
  const [key, setKey] = useState(() => resources[0] || '')
  const [dataUrl, setDataUrl] = useState('')
  // 默认框按画面比例给一个（顶栏那条带里偏左一点），选完图之后重算
  const [box, setBox] = useState({ x: 0, y: 0, w: 200, h: 80 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  function pickFile(event) {
    const file = event.target.files && event.target.files[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      setDataUrl(url)
      const img = new Image()
      img.onload = () => {
        setBox({
          x: Math.round(img.naturalWidth * 0.25),
          y: Math.round(img.naturalHeight * 0.02),
          w: Math.round(img.naturalWidth * 0.06),
          h: Math.round(img.naturalHeight * 0.05),
        })
      }
      img.src = url
    }
    reader.readAsDataURL(file)
  }

  async function submit(event) {
    event.preventDefault()
    if (!dataUrl) {
      setError('先选一张截图')
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await api.post('/api/ocr/icons', { key, data_url: dataUrl, box })
      toast(`${r.key} 的模板已存下（${r.size[0]}×${r.size[1]}）`, 'ok', 4200)
      onDone()
      close(r)
    } catch (err) {
      setError((err && err.message) || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const numField = (name, label) => (
    <label className="inline" key={name}>
      <span className="dim tiny">{label}</span>
      <TextInput
        numeric
        aria-label={name}
        style={{ width: '76px' }}
        value={String(box[name])}
        onChange={(value) => setBox((current) => ({ ...current, [name]: Number(value) || 0 }))}
      />
    </label>
  )

  return (
    <Drawer
      title="自备图标模板"
      subtitle="游戏版本更新、图标改了样子，就自己抠一个"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>取消</button>
          <div style={{ flex: '1' }} />
          <button className="btn btn--primary" type="submit" form={ICON_FORM_ID} disabled={busy} data-loading={busy ? '1' : undefined}>抠出来存下</button>
        </>
      }
    >
      <form id={ICON_FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <Field label="图标类型">
              <SelectInput value={key} onChange={setKey} options={resources.map((item) => ({ value: item, label: item }))} />
            </Field>
            <Field label="游戏截图（顶栏那张）">
              <div className="stack stack--tight">
                <button className="btn btn--sm" type="button" onClick={() => fileRef.current && fileRef.current.click()}><Upload {...iconProps(14)} />选一张图</button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={pickFile} />
                <img src={dataUrl || undefined} alt="截图预览" style={{ maxWidth: '100%', borderRadius: '8px', marginTop: '6px' }} />
                <div className="tbl__meta">选完图之后程序会给一个默认的方框；把下面四个数改成图标本体所在的位置。</div>
              </div>
            </Field>
            <Field label="图标所在的方框（像素）">
              <div className="cluster" style={{ gap: '8px', flexWrap: 'wrap' }}>
                {numField('x', 'x')}
                {numField('y', 'y')}
                {numField('w', '宽')}
                {numField('h', '高')}
              </div>
            </Field>
          </div>
          {error ? <div className="note note--alert">{error}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

/* ---------------- 导出备份 ---------------- */

async function exportBackup() {
  const data = await api.get('/api/backup/export')
  const text = JSON.stringify(data, null, 2)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name = `代肝运营台-备份-${stamp}.json`
  // 和「生成图片 / 生成 Word」走同一个下载件（public/js/pricecard.js）
  downloadBlob(new Blob([text], { type: 'application/json' }), name)
  const counts = data.counts || {}
  toast(`备份已导出：${counts.orders || 0} 单 / ${counts.customers || 0} 客户 / ${counts.credentials || 0} 凭证`, 'ok', 4200)
}
