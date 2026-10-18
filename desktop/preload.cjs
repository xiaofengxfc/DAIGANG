/**
 * preload：网页和桌面外壳之间唯一的通道。
 *
 * 只用 contextBridge 暴露几个只读能力和两个明确动作，
 * 不把 ipcRenderer、Node 的 require、fs 交给页面 —— 页面拿到的
 * 就是一个普通浏览器环境，跟用浏览器打开时行为一致。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('daiganDesktop', {
  /** 桌面外壳特有的信息；用浏览器打开时这个对象不存在，页面要判空 */
  info: () => ipcRenderer.invoke('desktop:info'),
  /** 'data' | 'log' —— 让用户能在资源管理器里看到文件 */
  open: (target) => ipcRenderer.invoke('desktop:open', target),
  /** 开机自启开关（设置页用） */
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('desktop:open-at-login', enabled),
})
