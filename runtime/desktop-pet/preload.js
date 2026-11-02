/**
 * preload：只暴露一组窄接口给 pet.html / outfit.html，渲染端没有 Node 权限。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petApi', {
  /** 拖动窗口：位移量（px） */
  moveBy: (dx, dy) => ipcRenderer.send('pet:move', dx, dy),
  /** 拖动结束：让主进程记住窗口位置 */
  moveEnd: () => ipcRenderer.send('pet:move-end'),
  /** 被枪击：告诉宿主把模式切成 off */
  shot: () => ipcRenderer.send('pet:shot'),
  /** 关掉自己（枪击动画播完） */
  quit: () => ipcRenderer.send('pet:quit'),
  /** 查余额：主进程转给宿主，宿主回结果 */
  balance: () => ipcRenderer.invoke('pet:balance'),
  /** 指针是否落在猫身上：落在猫上是 true，透明区域是 false（窗口据此穿透点击） */
  setHover: (hover) => ipcRenderer.send('pet:hover', !!hover),
  /** 形态展示卡片出现/收起：主进程据此临时把窗口往上长一截 */
  formOpen: (open) => ipcRenderer.send('pet:form', !!open),

  // ---- 自定义装扮 ----
  /** 打开「自定义装扮」面板窗口 */
  openOutfit: () => ipcRenderer.send('pet:outfit'),
  /** 对话：把一句话发给宿主，拿回 { ok, text, sticker } */
  chat: (text, history, avoidSticker) => ipcRenderer.invoke('pet:chat-send', text, history, avoidSticker),
  /** 输入框打开/关闭：窗口据此切换「可交互」与「穿透点击」 */
  typing: (active) => ipcRenderer.send('pet:typing', !!active),
  /** 保存自定义形象（data:image/png;base64,…） */
  saveSkin: (dataUrl) => ipcRenderer.invoke('pet:save-skin', dataUrl),
  /** 恢复默认形象 */
  resetSkin: () => ipcRenderer.invoke('pet:reset-skin'),
  /** 关掉面板窗口 */
  closePanel: () => ipcRenderer.send('pet:close-panel'),
  /** 主进程推来的形象（{ dataUrl } 或 { dataUrl: null }） */
  onSkin: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('pet:skin', (_event, payload) => callback(payload));
  },
});
