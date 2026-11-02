/**
 * 小猫coke —— 宿主半侧（Cordis 插件）。
 *
 * 挂 `/dsh-coke` 前缀路由，并且管一个**桌面窗口**子进程（透明置顶的 Electron 小窗）：
 *
 *   GET  /asset/*                贴图 / 语音 / 枪声
 *   GET  /config                 外观 + 当前模式（desktop / inline / off）+ 桌面窗口状态
 *   POST /mode?to=desktop|inline|off   切模式（desktop 会拉起桌面窗口）
 *   GET  /balance                DeepSeek 官方余额
 *   POST /uninstall?confirm=1    自我卸载
 *
 * 「自动启动」= DSH 起来后 apply() 里按 state.json 的模式把桌面窗口拉起来
 * （默认 desktop，所以重启 DSH 猫就会自己出现在桌面上）。
 *
 * 桌面窗口与宿主之间用 stdout/stdin 的 JSON 行通信（不走 HTTP：
 * DSH Desktop 的访问闸门会拦插件子进程的裸 HTTP 请求）。
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  buildSystemPrompt,
  cleanText,
  detect,
  extractSticker,
  fallbackReply,
  imageInstruction,
  randomSticker,
} from './coke-voice.js';

/** 插件名（cordis 行 id 见 cordis.patch.yml：dsh-coke）。 */
export const name = 'coke';

/** 展示用名字：设置页里那一栏就叫这个。 */
export const displayName = '小猫coke';

/** 只硬依赖 webServer（路由）；其余服务全部按需软取。 */
export const inject = ['webServer'];

const PACKAGE_NAME = 'dsh-coke';
const ROUTE_PREFIX = '/dsh-coke';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = join(PACKAGE_ROOT, 'assets');
const DESKTOP_APP_DIR = join(PACKAGE_ROOT, 'runtime', 'desktop-pet');

/** 允许从 assets/ 直接取的扩展名（换成 mp3 语音、换贴图都不用改代码）。 */
const MIME = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

/** 用户可调的默认外观（写成 ~/.dsh/dsh-coke/config.json 覆盖）。 */
const DEFAULT_CONFIG = {
  /** 小猫显示高度（px）；宽度按贴图比例自适应 */
  size: 220,
  /** 距离屏幕右边的像素 / 视口右边 */
  right: 26,
  /** 距离屏幕下边 / 视口下边 */
  bottom: 20,
  /** 台词气泡停留毫秒数 */
  bubbleMs: 1600,
  /** 形态展示卡片停留毫秒数（默认 1 分钟，写 config.json 可以改） */
  formMs: 60000,
};

/** 显示模式：desktop = 桌面透明窗口，inline = 页面内浮层，off = 关掉 */
const MODES = new Set(['desktop', 'inline', 'off']);
const DEFAULT_MODE = 'desktop';

/** 余额查询的固定凭证名（DSH 凭证服务里的环境变量名）。 */
const BALANCE_CREDENTIAL = 'DEEPSEEK_API_KEY';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';

/** 桌面窗口的运行态（进程句柄、是否 ready、最近错误、回程端口） */
const desktop = {
  child: null,
  ready: false,
  error: null,
  stopping: false,
  startedAt: 0,
  bridge: { port: 0, token: '' },
};

/** apply() 拿到的宿主上下文：桌面窗口要查余额时复用它（凭证服务在 ctx 上）。 */
let hostCtx = null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 读请求体（带上限，超了直接掐断，别把主进程吃满）。 */
function readBody(req, limit) {
  return new Promise((resolveDone, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveDone(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function sendFile(res, entry) {
  let info;
  try {
    info = await stat(entry.file);
  } catch {
    sendText(res, 404, 'dsh-coke: asset missing');
    return;
  }
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': info.size,
    'Cache-Control': entry.cache || 'public, max-age=600',
  });
  createReadStream(entry.file).on('error', () => {
    if (!res.writableEnded) res.end();
  }).pipe(res);
}

/**
 * 把 /asset/<文件名> 解析成磁盘路径；只允许 assets 目录里、扩展名在白名单里的文件。
 * @param {string} name 文件名（不含路径）
 */
function assetEntry(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const type = MIME[name.slice(dot).toLowerCase()];
  if (!type) return null;
  return { file: join(ASSET_DIR, name), type };
}

function userConfigDir() {
  // COKE_CAT_USER_DIR 是给桌面窗口与自测用的覆盖点（默认 ~/.dsh/dsh-coke）
  return process.env.COKE_CAT_USER_DIR || join(homedir(), '.dsh', PACKAGE_NAME);
}

function userConfigPath() {
  return join(userConfigDir(), 'config.json');
}

function statePath() {
  return join(userConfigDir(), 'state.json');
}

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(userConfigPath(), 'utf8'));
    const out = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const value = parsed?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 自定义形象：图片放在用户目录里（皮肤只影响贴图，不影响任何其它功能）。 */
function skinFile() {
  return join(userConfigDir(), 'skin.png');
}

function skinMetaFile() {
  return join(userConfigDir(), 'skin.json');
}

/** 读自定义形象状态（存在即生效）。 */
async function readSkinInfo() {
  try {
    const info = await stat(skinFile());
    let savedAt = null;
    try {
      savedAt = JSON.parse(await readFile(skinMetaFile(), 'utf8'))?.savedAt ?? null;
    } catch {
      savedAt = null;
    }
    return {
      custom: true,
      savedAt: savedAt || info.mtime.toISOString(),
      url: '/dsh-coke/skin.png?v=' + encodeURIComponent(String(info.mtimeMs)),
    };
  } catch {
    return { custom: false, savedAt: null, url: null };
  }
}

/** 保存自定义形象：只接受 PNG 的 dataURL，写完再落一份元信息。 */
async function saveSkin(dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) return { ok: false, message: '只接受 PNG 图片（data:image/png;base64,…）' };
  const buffer = Buffer.from(match[1], 'base64');
  if (buffer.length < 200) return { ok: false, message: '图片数据太小，疑似无效' };
  if (buffer.length > 12 * 1024 * 1024) return { ok: false, message: '图片太大（上限 12MB）' };
  // PNG magic：89 50 4E 47
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) {
    return { ok: false, message: '不是有效的 PNG' };
  }
  try {
    await mkdir(userConfigDir(), { recursive: true });
    const savedAt = new Date().toISOString();
    await writeFile(skinFile(), buffer);
    await writeFile(skinMetaFile(), JSON.stringify({ savedAt, bytes: buffer.length }, null, 2) + '\n', 'utf8');
    return { ok: true, savedAt, bytes: buffer.length };
  } catch (error) {
    return { ok: false, message: '写文件失败：' + (error instanceof Error ? error.message : String(error)) };
  }
}

async function resetSkin() {
  await rm(skinFile(), { force: true }).catch(() => {});
  await rm(skinMetaFile(), { force: true }).catch(() => {});
  return { ok: true };
}

/** 读显示模式状态（desktop / inline / off + 最近错误）。读不到就用默认值。 */
async function readModeState() {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8'));
    const mode = MODES.has(parsed?.mode) ? parsed.mode : DEFAULT_MODE;
    return { mode, lastError: typeof parsed?.lastError === 'string' ? parsed.lastError : null };
  } catch {
    return { mode: DEFAULT_MODE, lastError: null };
  }
}

async function writeModeState(patch) {
  const current = await readModeState();
  const next = { ...current, ...patch };
  try {
    await mkdir(userConfigDir(), { recursive: true });
    await writeFile(statePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {
    /* 写不了就只在这个进程里生效 */
  }
  return next;
}

/** Electron 可执行文件：环境变量优先，其次 ~/.dsh/electron（我们自己也会下到这里）。 */
function findElectron() {
  const candidates = [];
  if (process.env.COKE_CAT_ELECTRON) candidates.push(process.env.COKE_CAT_ELECTRON);
  const root = process.env.DSH_HOME || join(homedir(), '.dsh');
  if (process.platform === 'win32') {
    candidates.push(join(root, 'electron', 'electron.exe'));
  } else if (process.platform === 'darwin') {
    candidates.push(join(root, 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
  } else {
    candidates.push(join(root, 'electron', 'electron'));
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Electron 首次使用自动下载（别人装了这个插件、机器上还没有 Electron 时用）
// ---------------------------------------------------------------------------
const ELECTRON_VERSION = process.env.COKE_ELECTRON_VERSION || '43.3.0';
const ELECTRON_MIRROR =
  process.env.COKE_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

const electronState = { running: false, error: null, doneAt: 0, promise: null };
/** 用户点「桌面窗口」但当时没 Electron：下载完要不要自动切过去 */
let pendingDesktop = false;

function electronPlatformTag() {
  if (process.platform === 'win32') return 'win32-' + process.arch;
  if (process.platform === 'darwin') return 'darwin-' + process.arch;
  return 'linux-' + process.arch;
}

function electronLandingDir() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'electron');
}

/** 下载 + 解压 Electron 包到 ~/.dsh/electron；成功返回可执行路径 */
async function ensureElectron() {
  const existing = findElectron();
  if (existing) return existing;
  if (electronState.promise) return electronState.promise;

  electronState.running = true;
  electronState.error = null;
  electronState.promise = (async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const zipName = 'electron-v' + ELECTRON_VERSION + '-' + electronPlatformTag() + '.zip';
    const url = ELECTRON_MIRROR.replace(/\/$/, '') + '/' + ELECTRON_VERSION + '/' + zipName;
    const dir = electronLandingDir();
    const scratch = await mkdtemp(join(tmpdir(), 'coke-electron-'));
    const zipPath = join(scratch, 'electron.zip');

    console.log('[dsh-coke] 没找到 Electron，开始下载 ' + url);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error('下载失败 HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(zipPath, buffer);
    console.log('[dsh-coke] 下载完成 ' + (buffer.length / 1024 / 1024).toFixed(1) + 'MB，开始解压');

    await mkdir(dir, { recursive: true });
    // Windows/macOS 自带 bsdtar，能直接解 zip；Linux 退回 unzip
    const ok = await new Promise((resolve) => {
      const child = spawn('tar', ['-xf', zipPath, '-C', dir], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
    if (!ok) {
      await new Promise((resolve) => {
        const child = spawn('unzip', ['-o', '-q', zipPath, '-d', dir], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('exit', () => resolve(true));
      });
    }
    const exe = findElectron();
    if (!exe) throw new Error('解压完了但没找到 Electron 可执行文件');
    console.log('[dsh-coke] Electron 就绪：' + exe);
    return exe;
  })()
    .then((exe) => {
      electronState.doneAt = Date.now();
      return exe;
    })
    .catch((error) => {
      electronState.error = error instanceof Error ? error.message : String(error);
      console.warn('[dsh-coke] Electron 下载失败：' + electronState.error);
      return null;
    })
    .then((exe) => {
      electronState.running = false;
      electronState.promise = null;
      return exe;
    });

  return electronState.promise;
}

// ---------------------------------------------------------------------------
// 桌面窗口
// ---------------------------------------------------------------------------
/**
 * 拉起桌面窗口。
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
async function startDesktop() {
  if (desktop.child) return { ok: true, message: '桌面窗口已经在运行' };
  if (!existsSync(join(DESKTOP_APP_DIR, 'main.js'))) {
    return { ok: false, message: '缺少桌面窗口运行时（runtime/desktop-pet）' };
  }
  const electron = findElectron();
  if (!electron) {
    // 机器上还没 Electron：后台下载一份（不阻塞这次请求），下完自动切到桌面窗口
    pendingDesktop = true;
    if (!electronState.running) {
      void ensureElectron().then(async (exe) => {
        if (!exe || !pendingDesktop) return;
        pendingDesktop = false;
        const started = await startDesktop();
        if (started.ok) await writeModeState({ mode: 'desktop', lastError: null });
      });
    }
    return {
      ok: false,
      message: '正在后台下载 Electron（约 100MB），下完会自动切到桌面窗口；也可以先用页面内模式',
      downloading: true,
    };
  }
  pendingDesktop = false;

  const config = await readConfig();
  const env = { ...process.env };
  // 子进程必须作为真正的 Electron 跑，不能继承「把 electron 当 node 用」的开关
  delete env.ELECTRON_RUN_AS_NODE;
  env.COKE_CAT_BRIDGE = '1';
  env.COKE_CAT_CONFIG = JSON.stringify(config);
  env.COKE_CAT_USER_DIR = userConfigDir();

  let child;
  try {
    child = spawn(electron, [DESKTOP_APP_DIR], {
      cwd: DESKTOP_APP_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return { ok: false, message: '拉起桌面窗口失败：' + (error instanceof Error ? error.message : String(error)) };
  }

  desktop.child = child;
  desktop.ready = false;
  desktop.error = null;
  desktop.stopping = false;
  desktop.startedAt = Date.now();
  desktop.bridge = { port: 0, token: '' };

  /**
   * 往子进程送消息。
   * 回程走子进程自己开的迷你 HTTP 口（Windows 的 GUI 进程 stdin 会立刻 end，不能用）。
   */
  const reply = (obj) => {
    const { port, token } = desktop.bridge;
    if (!port) return;
    void fetch('http://127.0.0.1:' + port + '/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-coke-token': token },
      body: JSON.stringify(obj),
      signal: AbortSignal.timeout(3000),
    }).catch((error) => {
      console.debug('[dsh-coke/desktop] bridge reply failed: ' + (error instanceof Error ? error.message : String(error)));
    });
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.kind === 'ready') {
      desktop.ready = true;
      desktop.bridge = { port: Number(msg.port) || 0, token: String(msg.token || '') };
    } else if (msg.kind === 'call') {
      void (async () => {
        let status = 200;
        let body = { ok: false, message: '未知路由' };
        try {
          const result = await handleRoute(hostCtx, msg.path, msg.method || 'GET', msg.body);
          status = result.status ?? 200;
          body = result.obj ?? { ok: false };
        } catch (error) {
          status = 500;
          body = { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
        reply({ kind: 'result', id: msg.id, status, body });
      })();
    } else if (msg.kind === 'shot') {
      // 被枪击：记成 off，重启也不会自动复活
      void writeModeState({ mode: 'off' });
    } else if (msg.kind === 'log') {
      console.debug('[dsh-coke/desktop] ' + msg.message);
    }
  });

  createInterface({ input: child.stderr }).on('line', (line) => {
    const text = line.trim();
    if (text) console.debug('[dsh-coke/desktop:err] ' + text);
  });

  child.on('error', (error) => {
    desktop.error = error instanceof Error ? error.message : String(error);
    desktop.ready = false;
  });

  child.on('exit', (code) => {
    // 被我们自己停掉、或者刚起来就退出（崩溃）要区分开
    if (!desktop.stopping && Date.now() - desktop.startedAt < 4000 && code !== 0) {
      desktop.error = '桌面窗口启动后很快退出（code ' + code + '）';
    }
    desktop.child = null;
    desktop.ready = false;
    desktop.stopping = false;
  });

  return { ok: true, message: '桌面窗口正在启动' };
}

/** 停掉桌面窗口（先好好说再见，1500ms 不退就杀进程）。 */
async function stopDesktop() {
  const child = desktop.child;
  if (!child) return;
  desktop.stopping = true;

  const done = new Promise((resolveDone) => {
    child.once('exit', resolveDone);
  });

  const { port, token } = desktop.bridge;
  if (port) {
    try {
      await fetch('http://127.0.0.1:' + port + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-coke-token': token },
        body: JSON.stringify({ kind: 'quit' }),
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      /* 端口已经没了就直接杀 */
    }
  }

  let killTimer = null;
  const timeout = new Promise((resolveDone) => {
    killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolveDone();
    }, 1500);
  });
  await Promise.race([done, timeout]);
  if (killTimer) clearTimeout(killTimer);

  desktop.child = null;
  desktop.ready = false;
  desktop.bridge = { port: 0, token: '' };
}

/**
 * 切显示模式：desktop 会拉起窗口；inline / off 会先关窗口。
 * 桌面窗口起不来时自动退回 inline（页面内浮层），避免「什么都没出现」。
 */
async function setMode(target) {
  if (!MODES.has(target)) {
    return { ok: false, message: '模式只能是 desktop / inline / off', mode: (await readModeState()).mode };
  }
  if (target === 'desktop') {
    const started = await startDesktop();
    if (!started.ok) {
      await writeModeState({ mode: 'inline', lastError: started.message });
      await stopDesktop();
      return { ok: false, message: started.message, mode: 'inline', fellBack: true };
    }
    await writeModeState({ mode: 'desktop', lastError: null });
    return { ok: true, mode: 'desktop', message: started.message };
  }
  await stopDesktop();
  await writeModeState({ mode: target, lastError: null });
  return { ok: true, mode: target };
}

function desktopStatus() {
  return {
    supported: Boolean(findElectron()),
    running: desktop.ready,
    error: desktop.error,
    pid: desktop.child ? desktop.child.pid : null,
  };
}

// ---------------------------------------------------------------------------
// 余额
// ---------------------------------------------------------------------------
async function resolveCredential(ctx, ref) {
  const credentials = ctx?.get?.('credentials', false);
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const record = await credentials.resolve(ref);
      // 服务返回 { value }；不同版本也可能直接给字符串，两种都认
      if (typeof record === 'string' && record) return record;
      if (record && typeof record.value === 'string' && record.value) return record.value;
    } catch {
      /* 解析失败就退回环境变量 */
    }
  }
  const fromEnv = process.env[ref];
  return fromEnv ? String(fromEnv) : undefined;
}

async function queryBalance(ctx) {
  const key = await resolveCredential(ctx, BALANCE_CREDENTIAL);
  if (!key) {
    return {
      ok: false,
      reason: 'credential-missing',
      message: '没找到 ' + BALANCE_CREDENTIAL + '，先在设置→模型里写入密钥再查',
    };
  }
  let res;
  try {
    res = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'fetch-error',
      message: '余额接口连不上：' + (error instanceof Error ? error.message : String(error)),
    };
  }
  if (!res.ok) {
    return { ok: false, reason: 'fetch-error', message: '余额接口返回 HTTP ' + res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'fetch-error', message: '余额接口返回的不是 JSON' };
  }
  const infos = body?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return { ok: false, reason: 'fetch-error', message: '余额响应里没有 balance_infos' };
  }
  const wallets = infos.map((item) => ({
    currency: String(item?.currency ?? 'CNY'),
    total: String(item?.total_balance ?? '0'),
    granted: String(item?.granted_balance ?? '0'),
    toppedUp: String(item?.topped_up_balance ?? '0'),
  }));
  const shown = wallets.find((w) => w.currency === 'CNY') ?? wallets[0];
  const symbol = shown.currency === 'CNY' ? '¥' : shown.currency === 'USD' ? '$' : shown.currency + ' ';
  return {
    ok: true,
    source: 'DeepSeek 官方',
    currency: shown.currency,
    amount: symbol + shown.total,
    total: shown.total,
    granted: shown.granted,
    toppedUp: shown.toppedUp,
    wallets,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 卸载
// ---------------------------------------------------------------------------
function locateSelf() {
  const libDir = dirname(fileURLToPath(import.meta.url));
  const pkgDir = resolve(libDir, '..');
  const nodeModules = dirname(pkgDir);
  if (basename(pkgDir) !== PACKAGE_NAME) return null;
  if (basename(nodeModules) !== 'node_modules') return null;
  return { pkgDir, profileDir: dirname(nodeModules) };
}

async function uninstallSelf() {
  const self = locateSelf();
  if (!self) {
    return {
      ok: false,
      message: '当前不是从 profile 的 node_modules 加载的，无法自动卸载（请手动删除安装目录）',
    };
  }
  const manifestPath = join(self.profileDir, 'package.json');
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (error) {
    return { ok: false, message: '读不到 profile 清单：' + (error instanceof Error ? error.message : String(error)) };
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'profile 清单不是合法 JSON，已中止（没有改动任何文件）' };
  }

  let changed = false;
  if (manifest.dependencies && Object.hasOwn(manifest.dependencies, PACKAGE_NAME)) {
    delete manifest.dependencies[PACKAGE_NAME];
    changed = true;
  }
  const bundles = manifest.dsh?.profile?.bundles;
  if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PACKAGE_NAME);
    changed = true;
  }

  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(manifestPath + '.bak-coke-' + stamp, raw, 'utf8');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }

  // 先关桌面窗口，再删自己的目录（删完这个进程里的模块仍在内存里）
  void stopDesktop();
  setTimeout(() => {
    void rm(self.pkgDir, { recursive: true, force: true }).catch(() => {});
    void rm(userConfigDir(), { recursive: true, force: true }).catch(() => {});
  }, 600).unref?.();

  return {
    ok: true,
    changed,
    message: changed ? '已从 profile 移除，重启 DSH 后彻底消失' : '清单里本来就没有这个名字，已删除目录',
  };
}

// ---------------------------------------------------------------------------
// 对话：模型优先，规则兜底
// ---------------------------------------------------------------------------

/** 从各种块结构里尽量把文本抠出来（不同 DSH 版本 chunk 形状可能不同） */
function collectText(chunk) {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk.text === 'string') return chunk.text;
  if (chunk.delta && typeof chunk.delta.text === 'string') return chunk.delta.text;
  if (Array.isArray(chunk.content)) {
    return chunk.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  }
  if (Array.isArray(chunk.blocks)) {
    return chunk.blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  }
  return '';
}

/** 当前对话在用的模型；取不到就返回 null（说明没法调模型） */
function currentModel(ctx) {
  try {
    const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentDefaultModel', false) : ctx?.agentDefaultModel;
    const selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null;
    if (selection && selection.provider && selection.model) {
      return { provider: String(selection.provider), model: String(selection.model) };
    }
  } catch {
    /* 没有这个服务就退回规则 */
  }
  return null;
}

/** 调一次模型，失败返回 null（调用方会给兜底回答） */
async function askModel(ctx, text, history) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm', false) : ctx?.llm;
  if (!llm || typeof llm.stream !== 'function') return null;
  const model = currentModel(ctx);
  if (!model) return null;

  const messages = [];
  for (const turn of history.slice(-6)) {
    if (!turn || typeof turn.text !== 'string' || !turn.text.trim()) continue;
    messages.push({
      role: turn.role === 'cat' ? 'assistant' : 'user',
      content: [{ type: 'text', text: turn.text.slice(0, 300) }],
    });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: text + imageInstruction() }] });

  try {
    let out = '';
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      sessionId: 'dsh-coke-chat',
      system: buildSystemPrompt(new Date()),
      messages,
      temperature: 1,
      signal: AbortSignal.timeout(45000),
    });
    for await (const chunk of stream) {
      out += collectText(chunk);
      if (out.length > 800) break;
    }
    const cleaned = cleanText(out);
    if (!cleaned) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/**
 * 一次对话：**文字必有**，表情包可选（约 55% 概率配一张）。
 * 模型不可用/超时/报错时用规则引擎兜底，所以前台永远不会「没有回答」。
 */
async function chatReply(ctx, rawBody, queryText) {
  let payload = {};
  try {
    payload = JSON.parse(String(rawBody || '{}'));
  } catch {
    payload = {};
  }
  const raw = typeof payload.text === 'string' && payload.text.trim() ? payload.text : String(queryText || '');
  const text = raw.trim().slice(0, 500);
  if (!text) return { ok: false, message: '说点什么', sticker: null };

  const history = Array.isArray(payload.history) ? payload.history.slice(-6) : [];
  const intent = detect(text);
  const rawAnswer = await askModel(ctx, text, history);

  let answer;
  let sticker = null;
  let via = 'fallback';
  if (rawAnswer) {
    // 模型自己决定要不要配图：它写 [图:名称] 才配
    const parsed = extractSticker(rawAnswer);
    answer = parsed.text;
    sticker = parsed.sticker;
    via = 'model';
  } else {
    answer = fallbackReply(text);
    // 没模型时随机点缀一张，营造表情包的味道（可选，不影响文字）
    if (Math.random() < 0.4) sticker = randomSticker(payload.avoidSticker);
  }

  if (!answer) answer = '喵～';
  return { ok: true, text: answer, sticker, via, intent };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
export async function handleRoute(ctx, rawUrl, method, body) {
  const url = new URL(rawUrl, 'http://localhost');
  const path = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length));

  if (path === '/health') return { kind: 'json', status: 200, obj: { ok: true, name } };

  if (path === '/config') {
    const config = await readConfig();
    const state = await readModeState();
    const skin = await readSkinInfo();
    return {
      kind: 'json',
      status: 200,
      obj: {
        ...config,
        mode: state.mode,
        lastError: state.lastError,
        desktop: desktopStatus(),
        skin,
      },
    };
  }

  // 自定义装扮面板（iframe 里跑的就是这个页面）
  if (path === '/outfit') {
    if (method !== 'GET') return { kind: 'text', status: 405, body: 'method not allowed' };
    return {
      kind: 'file',
      entry: { file: join(PACKAGE_ROOT, 'runtime', 'desktop-pet', 'outfit.html'), type: 'text/html; charset=utf-8' },
    };
  }

  // 对话：POST { text } → { ok, text, sticker }。优先走 DSH 的模型，模型不可用就用规则兜底
  // （桌面窗口走子进程的 JSON 行通道，带不了 body，所以也接受 ?text=）
  if (path === '/chat') {
    if (method !== 'POST') return { kind: 'json', status: 405, obj: { ok: false, message: '对话要用 POST' } };
    return { kind: 'json', status: 200, obj: await chatReply(ctx, body, url.searchParams.get('text')) };
  }

  // 自定义形象：POST 保存 / POST?reset=1 还原 / GET skin.png 取图
  if (path === '/skin') {
    if (method !== 'POST') return { kind: 'json', status: 405, obj: { ok: false, message: '保存形象要用 POST' } };
    if (url.searchParams.get('reset') === '1') {
      return { kind: 'json', status: 200, obj: await resetSkin() };
    }
    return { kind: 'json', status: 200, obj: await saveSkin(body) };
  }

  if (path === '/skin.png') {
    const entry = { file: skinFile(), type: 'image/png', cache: 'no-store' };
    try {
      await stat(entry.file);
    } catch {
      return { kind: 'text', status: 404, body: 'no custom skin' };
    }
    return { kind: 'file', entry };
  }

  if (path === '/mode') {
    if (method !== 'POST') {
      return { kind: 'json', status: 405, obj: { ok: false, message: '切模式要用 POST' } };
    }
    const target = url.searchParams.get('to') || '';
    const result = await setMode(target);
    return { kind: 'json', status: result.ok ? 200 : 400, obj: result };
  }

  if (path === '/desktop') {
    const state = await readModeState();
    return { kind: 'json', status: 200, obj: { ok: true, mode: state.mode, desktop: desktopStatus() } };
  }

  // Electron 状态：GET 查 / POST 触发下载（首次装插件、机器上还没有 Electron 时用）
  if (path === '/electron') {
    const ready = findElectron();
    if (method === 'POST') {
      if (!ready && !electronState.running) void ensureElectron();
      return {
        kind: 'json',
        status: 200,
        obj: { ok: true, ready: !!ready, path: ready, running: electronState.running, error: electronState.error },
      };
    }
    return {
      kind: 'json',
      status: 200,
      obj: { ok: true, ready: !!ready, path: ready, running: electronState.running, error: electronState.error },
    };
  }

  if (path === '/uninstall') {
    if (method !== 'POST') {
      return { kind: 'json', status: 405, obj: { ok: false, message: '卸载要用 POST' } };
    }
    if (url.searchParams.get('confirm') !== '1') {
      return { kind: 'json', status: 400, obj: { ok: false, message: '缺少 confirm=1（防止误触）' } };
    }
    return { kind: 'json', status: 200, obj: await uninstallSelf() };
  }

  if (path === '/balance') {
    const result = await queryBalance(ctx);
    return { kind: 'json', status: 200, obj: result };
  }

  const asset = path.startsWith('/asset/') ? assetEntry(path.slice('/asset/'.length)) : null;
  if (asset) {
    if (method !== 'GET' && method !== 'HEAD') {
      return { kind: 'text', status: 405, body: 'method not allowed' };
    }
    return { kind: 'file', entry: asset };
  }

  return { kind: 'text', status: 404, body: 'dsh-coke: unknown route ' + path };
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文
 */
export function apply(ctx) {
  hostCtx = ctx;
  void mkdir(userConfigDir(), { recursive: true }).catch(() => {});

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            // 只有保存形象需要请求体（dataURL 文本），限一下大小别吃爆内存
            let body;
            if (req.method === 'POST') {
              body = await readBody(req, 16 * 1024 * 1024).catch(() => undefined);
            }
            const result = await handleRoute(ctx, req.url ?? '/', req.method ?? 'GET', body);
            if (result.kind === 'json') sendJson(res, result.status, result.obj);
            else if (result.kind === 'text') sendText(res, result.status, result.body);
            else await sendFile(res, result.entry);
          } catch (error) {
            if (res.destroyed || res.writableEnded) return;
            sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
          }
        },
      }),
    'dsh-coke: /dsh-coke route',
  );

  // 自动启动：DSH 起来后按上次的模式把猫放出来（默认桌面窗口）。
  // 延迟一下，别和宿主自己的启动流程抢时间。
  const autoStart = setTimeout(() => {
    void (async () => {
      const state = await readModeState();
      if (state.mode !== 'desktop') return;
      const started = await startDesktop();
      if (!started.ok) {
        await writeModeState({ mode: 'inline', lastError: started.message });
      }
    })();
  }, 1500);
  autoStart.unref?.();

  ctx.effect(
    () => () => {
      clearTimeout(autoStart);
      void stopDesktop();
    },
    'dsh-coke: desktop window lifecycle',
  );
}
