/**
 * 小猫coke 的桌面窗口（Electron 主进程）。
 *
 * 由 dsh-coke 的宿主半侧 spawn 起来：一个无边框、透明、置顶、不进任务栏的小窗，
 * 里面只有那只猫。窗口自己的位置记在 ~/.dsh/dsh-coke/desktop-pos.json。
 *
 * 与宿主的通信（stdout/stdin 各一行 JSON）：
 *   → {"kind":"ready"}                      窗口就绪
 *   → {"kind":"call","id":"b1","path":"/balance","method":"POST"}   要宿主替它请求一次业务路由
 *   ← {"kind":"result","id":"b1","status":200,"body":{...}}
 *   → {"kind":"shot"}                       被枪击了（宿主据此把模式切成 off）
 *   → {"kind":"log","message":"..."}        诊断
 *
 * 自测：设 COKE_CAT_SELFTEST_DIR=<目录>，窗口加载完会自己点一下猫、截图、退出。
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

/** 宿主回程用的一次性口令：只有拿到它的进程能往这个口发消息 */
const BRIDGE_TOKEN = crypto.randomUUID();

const CONFIG = (() => {
  try {
    return JSON.parse(process.env.COKE_CAT_CONFIG || '{}');
  } catch {
    return {};
  }
})();

const SIZE = Math.max(120, Math.min(420, Number(CONFIG.size) || 220));
const SELFTEST = process.env.COKE_CAT_SELFTEST_DIR || '';
const USER_DIR = process.env.COKE_CAT_USER_DIR || path.join(app.getPath('home'), '.dsh', 'dsh-coke');
const POS_FILE = path.join(USER_DIR, 'desktop-pos.json');

// 猫身尺寸按贴图比例算（读 PNG 头，换素材不用改代码），上下留出气泡和余额药丸的位置
function readPngSize(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

const CAT_IMAGE = path.join(__dirname, '..', '..', 'assets', 'cat.png');
const CAT_METRICS = readPngSize(CAT_IMAGE) || { width: 702, height: 1288 };
const CAT_W = Math.round((SIZE * CAT_METRICS.width) / CAT_METRICS.height);
const WIN_W = Math.max(260, CAT_W + 150);
// 高度要给「气泡挂在头顶 + 猫跳起来那一下」留够余量（气泡会跟着脑袋抬）
const WIN_H = SIZE + 150;

let win = null;
/** 形态展示卡片出现时，窗口临时往上长这么高（不然卡片会被窗口边缘裁掉） */
const FORM_GROW = 220;
let formOpen = false;
/** 指针是否停在猫身上 / 对话输入框是否打开 */
let hoverActive = false;
let typingActive = false;
let formBaseBounds = null;
let grownBy = 0;
let pendingId = 0;
const waiting = new Map();

function out(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch {
    /* 管道断了就算了 */
  }
}

function log(message) {
  out({ kind: 'log', message: String(message) });
}

/** 让宿主替我们请求一次业务路由（余额等），宿主在 stdin 上回结果。 */
function callHost(routePath, method, timeoutMs, body) {
  const id = 'b' + (pendingId += 1);
  const limit = Number(timeoutMs) || 10000;
  out({ kind: 'call', id, path: routePath, method: method || 'GET', body: body });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, message: '宿主 ' + Math.round(limit / 1000) + ' 秒没有回应' });
    }, limit);
    waiting.set(id, (payload) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(payload);
    });
  });
}

function readSavedPosition() {
  try {
    const saved = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
    if (typeof saved.x === 'number' && typeof saved.y === 'number') return saved;
  } catch {
    /* 没存过就按默认位置 */
  }
  return null;
}

function defaultPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  const right = Number(CONFIG.right) >= 0 ? Number(CONFIG.right) : 26;
  const bottom = Number(CONFIG.bottom) >= 0 ? Number(CONFIG.bottom) : 20;
  return {
    x: Math.round(area.x + area.width - WIN_W - right),
    y: Math.round(area.y + area.height - WIN_H - bottom),
  };
}

function createWindow() {
  const pos = readSavedPosition() || defaultPosition();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: !!SELFTEST,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* 平台不支持就算了 */
    }
  }

  // 透明区域不吃鼠标点击：默认忽略，渲染端发现有元素在指针下再打开
  win.setIgnoreMouseEvents(true, { forward: true });

  const query = { size: String(SIZE), formMs: String(Number(CONFIG.formMs) || 60000) };
  win.loadFile(path.join(__dirname, 'pet.html'), { query });

  win.once('ready-to-show', () => {
    win.showInactive();
    void (async () => {
      const port = await startBridgeServer();
      out({ kind: 'ready', port, token: port ? BRIDGE_TOKEN : '' });
      pushSkin();
      if (SELFTEST) runSelfTest();
    })();
  });

  win.on('closed', () => {
    win = null;
    if (panelWin && !panelWin.isDestroyed()) panelWin.close();
    app.quit();
  });
}

// ---- 自定义形象：存在用户目录里，两个窗口都从这份文件取 ----
const SKIN_FILE = path.join(USER_DIR, 'skin.png');
let panelWin = null;

function readSkinDataUrl() {
  try {
    const buffer = fs.readFileSync(SKIN_FILE);
    if (!buffer.length) return null;
    return 'data:image/png;base64,' + buffer.toString('base64');
  } catch {
    return null;
  }
}

function pushSkin() {
  if (win && !win.isDestroyed()) win.webContents.send('pet:skin', { dataUrl: readSkinDataUrl() });
}

function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.show();
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 620,
    height: 600,
    minWidth: 520,
    minHeight: 520,
    title: '自定义装扮 · 小猫coke',
    backgroundColor: '#14171e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panelWin.setMenuBarVisibility(false);
  panelWin.loadFile(path.join(__dirname, 'outfit.html'));
  panelWin.once('ready-to-show', () => panelWin.show());
  panelWin.on('closed', () => {
    panelWin = null;
  });
}

ipcMain.on('pet:outfit', () => openPanel());

ipcMain.on('pet:close-panel', () => {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
});

/**
 * 「对话」：输入框就在小猫窗口里（和 dsh-pet 一样），所以窗口必须是可聚焦的——
 * focusable:false 的窗口里 textarea 永远拿不到键盘焦点。默认仍然穿透点击，
 * 只有输入框打开时才把窗口切成交互态。
 */
ipcMain.handle('pet:chat-send', async (_event, text, history, avoidSticker) => {
  const value = String(text || '').trim().slice(0, 500);
  if (!value) return { ok: false, message: '说点什么', sticker: null };
  const payload = JSON.stringify({
    text: value,
    history: Array.isArray(history) ? history.slice(-6) : [],
    avoidSticker: typeof avoidSticker === 'string' ? avoidSticker : null,
  });
  const result = await callHost('/dsh-coke/chat', 'POST', 25000, payload);
  return result && result.body ? result.body : { ok: false, message: '宿主没有回答', sticker: null };
});

/** 输入框打开 = 窗口要能收键盘和鼠标；关掉就恢复穿透 */
ipcMain.on('pet:typing', (_event, typing) => {
  if (!win || win.isDestroyed()) return;
  typingActive = !!typing;
  if (typingActive) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.focus();
  } else {
    win.setIgnoreMouseEvents(!hoverActive, { forward: true });
  }
});

ipcMain.handle('pet:save-skin', (_event, dataUrl) => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) return { ok: false, message: '只接受 PNG 图片' };
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length < 200) return { ok: false, message: '图片数据太小，疑似无效' };
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) {
    return { ok: false, message: '不是有效的 PNG' };
  }
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(SKIN_FILE, buffer);
    pushSkin();
    return { ok: true, bytes: buffer.length };
  } catch (error) {
    return { ok: false, message: '写文件失败：' + error.message };
  }
});

ipcMain.handle('pet:reset-skin', () => {
  try {
    fs.rmSync(SKIN_FILE, { force: true });
  } catch {
    /* 没有就算了 */
  }
  pushSkin();
  return { ok: true };
});

// ---- 渲染端的请求 ----
ipcMain.on('pet:hover', (_event, hover) => {
  if (!win || win.isDestroyed()) return;
  hoverActive = !!hover;
  if (typingActive) return; // 输入框开着时整窗都要能点
  win.setIgnoreMouseEvents(!hoverActive, { forward: true });
});

/**
 * 形态展示卡片比窗口高：出现时把窗口「往上」长一截（底边不动，猫不会跳位置），
 * 收起时还原。重复调用只动一次。
 */
ipcMain.on('pet:form', (_event, open) => {
  if (!win || win.isDestroyed()) return;
  const want = !!open;
  if (want === formOpen) return;
  const bounds = win.getBounds();
  if (want) {
    formBaseBounds = bounds;
    // 窗口贴着屏幕上沿时不能往上长（会跑到屏幕外），那就只长能长的那部分
    const grow = Math.min(FORM_GROW, Math.max(0, bounds.y));
    grownBy = grow;
    win.setBounds({ x: bounds.x, y: bounds.y - grow, width: bounds.width, height: bounds.height + grow });
    formOpen = true;
  } else {
    const base = formBaseBounds;
    formBaseBounds = null;
    formOpen = false;
    if (base) {
      win.setBounds({ x: bounds.x, y: bounds.y + grownBy, width: base.width, height: base.height });
      grownBy = 0;
    }
  }
});

ipcMain.on('pet:move', (_event, dx, dy) => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + Number(dx || 0)), Math.round(y + Number(dy || 0)));
});

ipcMain.on('pet:move-end', () => {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(POS_FILE, JSON.stringify({ x, y }), 'utf8');
  } catch {
    /* 写不了就只在本进程里有效 */
  }
});

ipcMain.on('pet:shot', () => {
  out({ kind: 'shot' });
});

ipcMain.on('pet:quit', () => {
  out({ kind: 'quit' });
  if (win && !win.isDestroyed()) win.close();
  app.quit();
});

ipcMain.handle('pet:balance', async () => {
  const result = await callHost('/dsh-coke/balance', 'GET');
  return result && result.body ? result.body : { ok: false, message: '宿主没有返回余额' };
});

// 宿主 → 子进程：Windows 的 GUI 进程拿到的 stdin 会立刻 end（实测拿不到数据），
// 所以回程不用 stdin，改成子进程起一个只监听 127.0.0.1 的迷你 HTTP 口，
// 端口与一次性 token 通过 stdout 的 ready 行告诉宿主。
let bridgeServer = null;
let bridgePort = 0;

function handleHostMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'result' && waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
  } else if (msg.kind === 'config' && win && !win.isDestroyed()) {
    win.webContents.send('pet:config', msg);
  } else if (msg.kind === 'quit') {
    app.quit();
  }
}

function startBridgeServer() {
  if (!process.env.COKE_CAT_BRIDGE || bridgeServer) return Promise.resolve(0);
  const token = BRIDGE_TOKEN;
  return new Promise((resolvePort) => {
    bridgeServer = http.createServer((req, res) => {
      if (req.headers['x-coke-token'] !== token) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('method not allowed');
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) req.destroy();
      });
      req.on('end', () => {
        try {
          handleHostMessage(JSON.parse(body || '{}'));
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(String(error && error.message));
        }
      });
    });
    bridgeServer.on('error', (error) => {
      log('bridge server error: ' + error.message);
      resolvePort(0);
    });
    bridgeServer.listen(0, '127.0.0.1', () => {
      bridgePort = bridgeServer.address().port;
      resolvePort(bridgePort);
    });
  });
}

// 宿主没了就自己退出，别留一个关不掉的透明窗口在桌面上
if (process.env.COKE_CAT_BRIDGE === '1') {
  const watchdog = setInterval(() => {
    const parent = process.ppid;
    if (!parent || parent <= 1) return;
    try {
      process.kill(parent, 0);
    } catch {
      app.quit();
    }
  }, 4000);
  watchdog.unref?.();
}

// ---- 自测：点一下猫、截两张图、退出 ----
function runSelfTest() {
  const dir = SELFTEST;
  const shotAt = async (name) => {
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, name), image.toPNG());
      log('captured ' + name);
    } catch (error) {
      log('capture failed: ' + error.message);
    }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await wait(700);
    await shotAt('desktop-idle.png');
    const [w, h] = win.getSize();
    const cx = Math.round(w / 2);
    const cy = Math.round(h * 0.62);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
    await wait(200);
    await shotAt('desktop-click.png');
    // 右键 → 菜单
    win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'right', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'right', clickCount: 1 });
    await wait(300);
    await shotAt('desktop-menu.png');
    // 形态展示：点菜单这一项，窗口会往上长一截，头顶出现「图 + 我痞吗」
    try {
      const beforeSize = win.getSize();
      await win.webContents.executeJavaScript("document.getElementById('form').click()");
      await wait(1100);
      const formState = await win.webContents.executeJavaScript(
        `document.getElementById('formAnchor').className + ' | ' +
         (document.getElementById('formImg').getAttribute('src') || '') + ' | ' +
         document.getElementById('formCaption').textContent`,
      );
      log('form ui: ' + formState + ' | window ' + beforeSize.join('x') + ' -> ' + win.getSize().join('x'));
      await shotAt('desktop-form.png');
      // 收起来，后面几步别被卡片挡着
      await win.webContents.executeJavaScript(
        "document.getElementById('formAnchor').classList.remove('on');" +
          'if (window.petApi) window.petApi.formOpen(false);',
      );
      await wait(500);
    } catch (error) {
      log('form probe failed: ' + error.message);
    }
    // 唱歌：直接点菜单里的那一项（比按坐标点更稳），看麦克风有没有掏出来
    try {
      await win.webContents.executeJavaScript("document.getElementById('sing').click()");
      await wait(900);
      const singState = await win.webContents.executeJavaScript(
        "document.getElementById('mic').className + ' | ' + document.getElementById('bubble').textContent",
      );
      log('sing ui: ' + singState);
    } catch (error) {
      log('sing probe failed: ' + error.message);
    }
    await shotAt('desktop-sing.png');
    // 关掉菜单，点一下脚下的「查余额」，验证「renderer → main → 宿主 → 回程」这条路
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    await wait(150);
    const [pw, ph] = win.getSize();
    const px = Math.round(pw / 2);
    const py = Math.round(ph - 30);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    await wait(700);
    try {
      const ui = await win.webContents.executeJavaScript(
        "document.getElementById('bal').textContent + ' | ' + document.getElementById('bubble').textContent",
      );
      log('balance ui: ' + ui);
    } catch (error) {
      log('balance probe failed: ' + error.message);
    }
    await shotAt('desktop-balance.png');
    // 自定义装扮面板：打开、截一张、关掉
    try {
      openPanel();
      await wait(1600);
      if (panelWin && !panelWin.isDestroyed()) {
        const panelImage = await panelWin.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'outfit-panel.png'), panelImage.toPNG());
        log('captured outfit-panel.png');
        panelWin.close();
      } else {
        log('panel did not open');
      }
    } catch (error) {
      log('panel probe failed: ' + error.message);
    }

    // 对话：点「对话」→ 头顶出现输入框（自测里没有宿主，只验输入框和「回车会把话发出去」）
    try {
      await win.webContents.executeJavaScript("document.getElementById('chat').click()");
      await wait(600);
      const opened = await win.webContents.executeJavaScript(
        "document.getElementById('inputAnchor').hidden === false",
      );
      await shotAt('desktop-input.png');
      await win.webContents.executeJavaScript(
        "(() => {" +
          "const el = document.getElementById('say');" +
          "el.value = '今天又要加班到十点';" +
          "el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));" +
          "})()",
      );
      await wait(900);
      const closed = await win.webContents.executeJavaScript(
        "document.getElementById('inputAnchor').hidden === true",
      );
      log('chat ui: inputOpened=' + opened + ' | inputClosedAfterEnter=' + closed);
    } catch (error) {
      log('chat probe failed: ' + error.message);
    }
    await wait(300);
    app.quit();
  })();
}

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(() => {
  app.setAppUserModelId('dsh.coke.cat');
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('quit', () => out({ kind: 'quit' }));
