/**
 * preload：网页和桌面外壳之间唯一的通道。
 *
 * 只用 contextBridge 暴露几个只读能力和几个明确动作，
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
  /**
   * 窗口按钮。
   *
   * 桌面版用 frame:false 把原生标题条整个去掉，右上角三个按钮由网页画，
   * 这样它们和顶栏里的其它图标用同一套尺寸、圆角、hover ——
   * 之前交给 titleBarOverlay 画，系统按钮是方角、贴着窗口边缘，
   * 和旁边的圆形图标并排就是两种东西。
   */
  window: {
    minimize: () => ipcRenderer.send('desktop:win', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('desktop:win', 'toggle-maximize'),
    close: () => ipcRenderer.send('desktop:win', 'close'),
    /** 订阅「窗口是不是最大化了」，返回取消订阅函数 */
    onMaximizedChange: (callback) => {
      const handler = (_event, maximized) => callback(Boolean(maximized))
      ipcRenderer.on('desktop:win-maximized', handler)
      return () => ipcRenderer.removeListener('desktop:win-maximized', handler)
    },
    isMaximized: () => ipcRenderer.invoke('desktop:win-maximized:get'),
  },
})
