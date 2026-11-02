/**
 * 小猫coke —— 浏览器半侧（DSH 客户端插件）。
 *
 * 契约（与 dsh-pet 一致）：本文件必须是**普通副作用脚本**，不含顶层 import/export；
 * 加载时调用 window.__ModuleLoader__.load({ id, factory })，factory 返回带
 * { name, inject, apply } 的 module。react 由 factory 的 require 取得，
 * 只用在设置页那一段（浮层本身是纯 DOM）。
 *
 * 显示模式由宿主决定（/config 里的 mode）：
 *   desktop —— 桌面上那个透明置顶窗口负责露脸，页面里不再重复挂浮层
 *   inline  —— 在 DSH 页面右下角挂浮层（桌面窗口起不来时的退路）
 *   off     —— 都不显示（被枪击 / 手动关闭）
 */
;(function () {
  'use strict';

  var PLUGIN_ID = 'dsh-coke';
  var ROUTE = '/dsh-coke';
  var TITLE = '小猫coke';
  var POS_KEY = 'dsh-coke:pos';

  var STYLE = `
  :host { all: initial; }
  .cc-root {
    position: fixed;
    z-index: 2147483000;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: none;
    font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
    -webkit-user-select: none;
    user-select: none;
  }
  .cc-stage {
    position: relative;
    line-height: 0;
    filter: drop-shadow(0 10px 22px rgba(0, 0, 0, .45));
  }
  .cc-idle {
    animation: cc-breathe 3.6s ease-in-out infinite;
    transform-origin: 50% 100%;
  }
  @keyframes cc-breathe {
    0%, 100% { transform: translate3d(0, 0, 0); }
    50%      { transform: translate3d(0, -5px, 0); }
  }
  .cc-cat {
    display: block;
    width: 100%;
    height: auto;
    pointer-events: auto;
    cursor: grab;
    touch-action: none;
    transform-origin: 50% 100%;
    will-change: transform;
    -webkit-user-drag: none;
  }
  .cc-cat:active,
  .cc-cat.cc-dragging { cursor: grabbing; }

  /* 气泡锚点在猫头顶上方；猫往上跳的时候锚点跟着抬，气泡就不会被脑袋顶穿 */
  .cc-bubble-anchor {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translate3d(-50%, var(--cc-hop, 0px), 0);
    z-index: 3;
    pointer-events: none;
    will-change: transform;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  /* 聊天回复可选配一张表情包：文字永远有，图是可选的 */
  .cc-bubble-pic {
    display: block;
    width: 132px;
    height: 132px;
    object-fit: cover;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, .18);
    box-shadow: 0 10px 26px rgba(0, 0, 0, .45);
  }
  .cc-bubble-pic[hidden] { display: none; }
  .cc-bubble {
    position: relative;
    width: max-content;
    max-width: 260px;
    transform: translate3d(0, 8px, 0) scale(.94);
    transform-origin: 50% 100%;
    padding: 9px 14px;
    border-radius: 15px;
    background: rgba(17, 19, 26, .93);
    border: 1px solid rgba(255, 255, 255, .16);
    box-shadow: 0 10px 28px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255, 255, 255, .06);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: .02em;
    line-height: 1.45;
    text-align: center;
    white-space: pre-line;
    opacity: 0;
    pointer-events: none;
    transition: opacity .16s ease, transform .28s cubic-bezier(.18, 1.5, .42, 1);
  }
  .cc-bubble.cc-show { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
  .cc-bubble::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 100%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: -4px;
    background: rgba(17, 19, 26, .93);
    border-right: 1px solid rgba(255, 255, 255, .16);
    border-bottom: 1px solid rgba(255, 255, 255, .16);
    transform: rotate(45deg);
    border-radius: 0 0 3px 0;
  }
  .cc-bubble.cc-error { font-weight: 600; font-size: 13px; color: #ffd7d7; }

  .cc-bal {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 13px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, .16);
    background: rgba(22, 25, 33, .82);
    backdrop-filter: blur(8px);
    color: #e8ecf5;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
    font-family: inherit;
    cursor: pointer;
    transition: background .18s ease, transform .18s ease, border-color .18s ease, opacity .3s ease;
    box-shadow: 0 6px 16px rgba(0, 0, 0, .32);
  }
  .cc-bal:hover { background: rgba(38, 44, 58, .92); border-color: rgba(255, 255, 255, .28); transform: translateY(-1px); }
  .cc-bal:active { transform: translateY(0) scale(.97); }
  .cc-bal[data-state="loading"] { opacity: .72; cursor: progress; }
  .cc-bal[data-state="ok"] { color: #b9f5cd; border-color: rgba(120, 240, 170, .35); }
  .cc-bal[data-state="error"] { color: #ffc9c9; border-color: rgba(255, 140, 140, .35); }

  .cc-menu {
    position: fixed;
    z-index: 5;
    min-width: 138px;
    padding: 5px;
    border-radius: 12px;
    background: rgba(20, 22, 30, .98);
    border: 1px solid rgba(255, 255, 255, .16);
    box-shadow: 0 16px 36px rgba(0, 0, 0, .55);
    pointer-events: auto;
  }
  .cc-menu[hidden] { display: none; }
  .cc-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #eef1f7;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .cc-menu-item:hover { background: rgba(255, 86, 86, .18); color: #ffd3d3; }
  .cc-menu-item .cc-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #ff6b6b;
    box-shadow: 0 0 8px rgba(255, 107, 107, .9);
  }
  .cc-menu-item.chat .cc-dot { background: #74c0fc; box-shadow: 0 0 8px rgba(116, 192, 252, .9); }
  .cc-menu-item.chat:hover { background: rgba(116, 192, 252, .18); color: #d0ebff; }
  .cc-menu-item.sing .cc-dot { background: #ffd166; box-shadow: 0 0 8px rgba(255, 209, 102, .9); }
  .cc-menu-item.sing:hover { background: rgba(255, 209, 102, .16); color: #ffe6a8; }
  .cc-menu-item.form .cc-dot { background: #b197fc; box-shadow: 0 0 8px rgba(177, 151, 252, .9); }
  .cc-menu-item.form:hover { background: rgba(177, 151, 252, .18); color: #e0d6ff; }
  .cc-menu-item.outfit .cc-dot { background: #8ce99a; box-shadow: 0 0 8px rgba(140, 233, 154, .9); }
  .cc-menu-item.outfit:hover { background: rgba(140, 233, 154, .16); color: #c6f6d5; }

  /* 自定义装扮：面板是同源 iframe，样式/脚本都在 /dsh-coke/outfit 里 */
  .cc-modal {
    position: fixed;
    inset: 0;
    z-index: 2147483100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(6, 8, 12, .58);
    pointer-events: auto;
  }
  .cc-modal[hidden] { display: none; }
  .cc-modal-box {
    width: min(600px, calc(100vw - 40px));
    height: min(560px, calc(100vh - 60px));
    border-radius: 16px;
    overflow: hidden;
    background: #14171e;
    border: 1px solid rgba(255, 255, 255, .16);
    box-shadow: 0 30px 80px rgba(0, 0, 0, .6);
    display: flex;
    flex-direction: column;
  }
  /* 对话输入框：挂在同一个头顶锚点上，跟气泡轮流出现 */
  .cc-input-anchor {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    transform: translate3d(-50%, var(--cc-hop, 0px), 0);
    z-index: 6;
    will-change: transform;
  }
  .cc-input-anchor[hidden] { display: none; }
  .cc-input-wrap {
    padding: 2px;
    border-radius: 12px;
    background: rgba(17, 19, 26, .97);
    border: 1px solid rgba(255, 255, 255, .2);
    box-shadow: 0 14px 34px rgba(0, 0, 0, .55);
  }
  .cc-input {
    display: block;
    width: 176px;
    min-height: 30px;
    max-height: 96px;
    padding: 6px 9px;
    border: 0;
    outline: 0;
    resize: none;
    background: transparent;
    color: #fff;
    font-family: inherit;
    font-size: 13.5px;
    line-height: 1.45;
  }
  .cc-input::placeholder { color: rgba(255, 255, 255, .3); }
  .cc-modal-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    background: rgba(255, 255, 255, .04);
    border-bottom: 1px solid rgba(255, 255, 255, .1);
    font-size: 13px;
    font-weight: 700;
    color: #e8ecf5;
  }
  .cc-modal-close {
    border: 0;
    background: transparent;
    color: #cfd6e4;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 6px;
  }
  .cc-modal-close:hover { background: rgba(255, 255, 255, .1); }
  .cc-modal iframe { flex: 1 1 auto; width: 100%; border: 0; background: #14171e; }

  /* 麦克风：从猫身后掏出来（外层做弹出，内层做摇摆，两套 transform 不打架） */
  .cc-mic {
    position: absolute;
    right: -6%;
    bottom: 22%;
    z-index: 2;
    width: 30%;
    max-width: 48px;
    opacity: 0;
    transform: translate3d(24px, 40px, 0) rotate(72deg) scale(.5);
    transform-origin: 60% 88%;
    transition: transform .45s cubic-bezier(.2, 1.55, .4, 1), opacity .2s ease;
    pointer-events: none;
    filter: drop-shadow(0 4px 10px rgba(0, 0, 0, .5));
  }
  .cc-mic.on { opacity: 1; transform: translate3d(0, 0, 0) rotate(-12deg) scale(1); }
  .cc-mic svg { display: block; width: 100%; height: auto; }
  .cc-mic.on svg { animation: cc-mic-sway 1.9s ease-in-out infinite; transform-origin: 50% 92%; }
  @keyframes cc-mic-sway {
    0%, 100% { transform: rotate(-3deg); }
    50% { transform: rotate(4deg); }
  }
  /* 形态展示：猫咪头上的一张「coke 形态」卡片（图 + 「我痞吗」），1 分钟后自动收 */
  .cc-form-anchor {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 8px);
    /* --cc-hop：跟着猫跳（猫跳到哪，卡片跟到哪） */
    transform: translate3d(-50%, var(--cc-hop, 0px), 0);
    z-index: 4;
    opacity: 0;
    pointer-events: none;
    will-change: transform;
    transition: opacity .18s ease;
  }
  .cc-form-anchor.on { opacity: 1; }
  .cc-form {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 5px;
    padding: 7px 7px 10px;
    border-radius: 16px;
    background: rgba(17, 19, 26, .95);
    border: 1px solid rgba(255, 255, 255, .16);
    box-shadow: 0 18px 44px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .06);
    transform: translate3d(0, 12px, 0) scale(.88);
    transform-origin: 50% 100%;
    transition: transform .32s cubic-bezier(.2, 1.55, .4, 1);
  }
  .cc-form-anchor.on .cc-form { transform: translate3d(0, 0, 0) scale(1); }
  .cc-form img {
    display: block;
    width: 168px;
    height: 168px;
    object-fit: cover;
    border-radius: 11px;
    background: #0b0d12;
  }
  .cc-form-caption {
    font-size: 13.5px;
    font-weight: 700;
    letter-spacing: .06em;
    color: #fff;
  }
  .cc-form::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 100%;
    width: 10px;
    height: 10px;
    margin-left: -5px;
    margin-top: -5px;
    background: rgba(17, 19, 26, .95);
    border-right: 1px solid rgba(255, 255, 255, .16);
    border-bottom: 1px solid rgba(255, 255, 255, .16);
    transform: rotate(45deg);
  }
  `;

  function assetUrl(name) {
    return ROUTE + '/asset/' + name;
  }

  // ---------------------------------------------------------------------------
  // 共享状态：浮层和设置页都读它（同一个 bundle 实例里的闭包）
  // ---------------------------------------------------------------------------
  var listeners = [];

  var state = {
    mode: 'inline',
    loaded: false,
    desktop: { supported: false, running: false, error: null },
    // 注意：这个对象会被 mount 直接引用，改配置时**原地赋值**，不要整体替换，
    // 否则已经挂载的浮层永远读不到新值（比如 formMs / size）
    appearance: { size: 220, right: 26, bottom: 20, bubbleMs: 1600, formMs: 60000 },
    lastError: null,
    busy: false,
    message: '',
  };

  function snapshot() {
    return {
      mode: state.mode,
      loaded: state.loaded,
      desktop: state.desktop,
      lastError: state.lastError,
      busy: state.busy,
      message: state.message,
    };
  }

  function emit() {
    for (var i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](snapshot());
      } catch (error) {
        console.warn('[dsh-coke] listener failed', error);
      }
    }
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    };
  }

  // 自定义形象（null = 用包里自带的那张）：浮层订阅它，面板一保存就换图
  var skinValue = null;
  var skinListeners = [];

  function setSkin(url) {
    skinValue = url || null;
    for (var i = 0; i < skinListeners.length; i += 1) {
      try {
        skinListeners[i](skinValue);
      } catch (error) {
        console.warn('[dsh-coke] skin listener failed', error);
      }
    }
  }

  function subscribeSkin(fn) {
    skinListeners.push(fn);
    return function () {
      var index = skinListeners.indexOf(fn);
      if (index >= 0) skinListeners.splice(index, 1);
    };
  }

  function setMessage(message) {
    state.message = message;
    emit();
  }

  function resetPosition() {
    try {
      window.localStorage.removeItem(POS_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  /** 拉一次宿主配置（模式 + 桌面窗口状态 + 外观）。 */
  function refreshConfig() {
    return fetch(ROUTE + '/config', { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        if (!cfg) return;
        state.mode = cfg.mode === 'desktop' || cfg.mode === 'off' ? cfg.mode : 'inline';
        state.desktop = cfg.desktop || { supported: false, running: false, error: null };
        state.lastError = cfg.lastError || null;
        // 原地更新（对象被 mount 引用着）
        var appearance = state.appearance;
        appearance.size = cfg.size || 220;
        appearance.right = typeof cfg.right === 'number' ? cfg.right : 26;
        appearance.bottom = typeof cfg.bottom === 'number' ? cfg.bottom : 20;
        appearance.bubbleMs = cfg.bubbleMs || 1600;
        appearance.formMs = cfg.formMs || 60000;
        state.loaded = true;
        // 自定义形象：有就换成它（带 mtime 查询串，避免缓存），没有就用包里那张
        setSkin(cfg.skin && cfg.skin.custom && cfg.skin.url ? cfg.skin.url : null);
        emit();
      })
      .catch(function () {
        // 宿主路由暂时不通：先按页面内浮层把猫放出来，别让它彻底消失
        state.loaded = true;
        emit();
      });
  }

  /** 切显示模式（桌面窗口 / 页面内 / 关闭）。 */
  function switchMode(target) {
    state.busy = true;
    emit();
    return fetch(ROUTE + '/mode?to=' + encodeURIComponent(target), { method: 'POST', cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (result) {
        state.busy = false;
        if (result && result.ok) {
          state.mode = result.mode;
          state.message = result.message || '';
        } else {
          state.mode = (result && result.mode) || state.mode;
          state.message = (result && result.message) || '切换失败';
        }
        return refreshConfig();
      })
      .catch(function (error) {
        state.busy = false;
        state.message = '切换失败：' + (error && error.message ? error.message : String(error));
        emit();
      });
  }

  /** 请求宿主把自己从 profile 里摘掉（真正的卸载）。 */
  function requestUninstall() {
    state.busy = true;
    state.message = '正在卸载…';
    emit();
    fetch(ROUTE + '/uninstall?confirm=1', { method: 'POST', cache: 'no-store' })
      .then(function (response) {
        return response.json();
      })
      .then(function (result) {
        state.busy = false;
        if (result && result.ok) {
          state.mode = 'off';
          state.message = result.message || '已卸载，重启 DSH 后彻底移除';
        } else {
          state.message = (result && result.message) || '卸载失败';
        }
        emit();
      })
      .catch(function (error) {
        state.busy = false;
        state.message = '卸载请求失败：' + (error && error.message ? error.message : String(error));
        emit();
      });
  }

  // ---------------------------------------------------------------------------
  // 页面内浮层
  // ---------------------------------------------------------------------------
  function mount(targetBody, config, hooks) {
    var host = document.createElement('div');
    host.setAttribute('data-dsh-coke', '');
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = STYLE;

    var root = document.createElement('div');
    root.className = 'cc-root';
    root.style.right = (config.right >>> 0) + 'px';
    root.style.bottom = (config.bottom >>> 0) + 'px';

    var savedPos = null;
    try {
      savedPos = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null');
    } catch (_) {
      savedPos = null;
    }

    function applyPos(left, top) {
      var maxLeft = Math.max(0, window.innerWidth - 40);
      var maxTop = Math.max(0, window.innerHeight - 40);
      var l = Math.min(Math.max(0, left), maxLeft);
      var t = Math.min(Math.max(0, top), maxTop);
      root.style.left = Math.round(l) + 'px';
      root.style.top = Math.round(t) + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }

    if (savedPos && typeof savedPos.left === 'number' && typeof savedPos.top === 'number') {
      applyPos(savedPos.left, savedPos.top);
    }

    var bubbleAnchor = document.createElement('div');
    bubbleAnchor.className = 'cc-bubble-anchor';
    var bubblePic = document.createElement('img');
    bubblePic.className = 'cc-bubble-pic';
    bubblePic.alt = 'coke 表情包';
    bubblePic.draggable = false;
    bubblePic.hidden = true;
    var bubble = document.createElement('div');
    bubble.className = 'cc-bubble';
    bubble.setAttribute('role', 'status');
    bubble.setAttribute('aria-live', 'polite');
    bubbleAnchor.appendChild(bubblePic);
    bubbleAnchor.appendChild(bubble);

    // 对话输入框（和气泡共用头顶位置，谁显示谁占位）
    var inputAnchor = document.createElement('div');
    inputAnchor.className = 'cc-input-anchor';
    inputAnchor.hidden = true;
    var inputWrap = document.createElement('div');
    inputWrap.className = 'cc-input-wrap';
    var input = document.createElement('textarea');
    input.className = 'cc-input';
    input.rows = 1;
    input.maxLength = 500;
    inputWrap.appendChild(input);
    inputAnchor.appendChild(inputWrap);

    var stage = document.createElement('div');
    stage.className = 'cc-stage';
    stage.style.height = (config.size >>> 0) + 'px';

    var idle = document.createElement('div');
    idle.className = 'cc-idle';

    var cat = document.createElement('img');
    cat.className = 'cc-cat';
    cat.alt = '我痞吗的猫';
    cat.draggable = false;
    cat.src = assetUrl('cat.png');
    cat.style.height = (config.size >>> 0) + 'px';
    cat.style.width = 'auto';

    idle.appendChild(cat);
    stage.appendChild(idle);

    // 麦克风（内联 SVG，不用额外素材）
    var MIC_SVG =
      '<svg viewBox="0 0 32 66" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<linearGradient id="ccMicHead" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#3a3f4a"/><stop offset=".42" stop-color="#e2e8f2"/>' +
      '<stop offset=".58" stop-color="#b6bfcd"/><stop offset="1" stop-color="#2b3038"/></linearGradient>' +
      '<linearGradient id="ccMicBody" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="#1f232a"/><stop offset=".4" stop-color="#8d96a5"/>' +
      '<stop offset=".62" stop-color="#69717e"/><stop offset="1" stop-color="#191c22"/></linearGradient>' +
      '</defs>' +
      '<ellipse cx="16" cy="16" rx="10.5" ry="13.5" fill="url(#ccMicHead)"/>' +
      '<g stroke="#2a2f38" stroke-width="1.3" opacity=".72">' +
      '<line x1="7.5" y1="10.5" x2="24.5" y2="10.5"/><line x1="6.5" y1="16" x2="25.5" y2="16"/>' +
      '<line x1="7.5" y1="21.5" x2="24.5" y2="21.5"/></g>' +
      '<rect x="9.5" y="26" width="13" height="4.5" rx="2.2" fill="#9aa3b2"/>' +
      '<rect x="13" y="29" width="6" height="27" rx="3" fill="url(#ccMicBody)"/>' +
      '<ellipse cx="16" cy="57" rx="5.4" ry="3.2" fill="#2a2f38"/>' +
      '</svg>';
    var mic = document.createElement('div');
    mic.className = 'cc-mic';
    mic.innerHTML = MIC_SVG;
    stage.appendChild(mic);

    // 形态展示卡片（头顶，图 + 「我痞吗」）
    var formAnchor = document.createElement('div');
    formAnchor.className = 'cc-form-anchor';
    var formEl = document.createElement('div');
    formEl.className = 'cc-form';
    var formImg = document.createElement('img');
    formImg.alt = 'coke 形态';
    formImg.draggable = false;
    var formCaption = document.createElement('div');
    formCaption.className = 'cc-form-caption';
    formCaption.textContent = '我痞吗';
    formEl.appendChild(formImg);
    formEl.appendChild(formCaption);
    formAnchor.appendChild(formEl);
    stage.appendChild(formAnchor);

    var bal = document.createElement('button');
    bal.className = 'cc-bal';
    bal.type = 'button';
    bal.textContent = '查余额';
    bal.dataset.state = 'idle';

    var menu = document.createElement('div');
    menu.className = 'cc-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');

    /** 造一个菜单项：一个色点 + 文案（文案会被 updateMenu 改写）。 */
    function makeMenuItem(label, extraClass) {
      var item = document.createElement('button');
      item.className = 'cc-menu-item' + (extraClass ? ' ' + extraClass : '');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      var dot = document.createElement('span');
      dot.className = 'cc-dot';
      var text = document.createElement('span');
      text.textContent = label;
      item.appendChild(dot);
      item.appendChild(text);
      return { item: item, text: text };
    }

    var singEntry = makeMenuItem('唱歌', 'sing');
    var chatEntry = makeMenuItem('对话', 'chat');
    var formEntry = makeMenuItem('形态展示', 'form');
    var outfitEntry = makeMenuItem('自定义装扮', 'outfit');
    var shootEntry = makeMenuItem('枪击小猫', 'shoot');
    var singItem = singEntry.item;
    var chatItem = chatEntry.item;
    var formItem = formEntry.item;
    var outfitItem = outfitEntry.item;
    var shootItem = shootEntry.item;
    menu.appendChild(chatItem);
    menu.appendChild(singItem);
    menu.appendChild(formItem);
    menu.appendChild(outfitItem);
    menu.appendChild(shootItem);

    // ---- 自定义装扮面板（同源 iframe，面板里自己做绿幕检测与抠图） ----
    var modal = document.createElement('div');
    modal.className = 'cc-modal';
    modal.hidden = true;
    var modalBox = document.createElement('div');
    modalBox.className = 'cc-modal-box';
    var modalBar = document.createElement('div');
    modalBar.className = 'cc-modal-bar';
    var modalTitle = document.createElement('span');
    modalTitle.textContent = '自定义装扮 · 小猫coke';
    var modalClose = document.createElement('button');
    modalClose.className = 'cc-modal-close';
    modalClose.type = 'button';
    modalClose.title = '关闭';
    modalClose.textContent = '×';
    modalBar.appendChild(modalTitle);
    modalBar.appendChild(modalClose);
    var panelFrameEl = document.createElement('iframe');
    panelFrameEl.setAttribute('title', '自定义装扮');
    modalBox.appendChild(modalBar);
    modalBox.appendChild(panelFrameEl);
    modal.appendChild(modalBox);

    var frameLoaded = false;
    function openPanel() {
      if (!frameLoaded) {
        panelFrameEl.src = ROUTE + '/outfit';
        frameLoaded = true;
      }
      modal.hidden = false;
    }
    function closePanel() {
      modal.hidden = true;
    }

    modalClose.addEventListener('click', closePanel);
    modal.addEventListener('pointerdown', function (event) {
      if (event.target === modal) closePanel();
    });

    // ---- 对话：猫头顶弹一个输入框（照 dsh-pet 的做法），回复直接进台词气泡 ----
    var chatHistory = [];
    var chatBusy = false;

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.max(30, Math.min(input.scrollHeight, 96)) + 'px';
      inputWrap.style.width = Math.max(180, Math.min(240, 40 + input.value.length * 8)) + 'px';
    }

    function openChat() {
      inputAnchor.hidden = false;
      bubble.classList.remove('cc-show');
      bubblePic.hidden = true;
      autosize();
      setTimeout(function () {
        try {
          input.focus();
        } catch (_) {
          /* ignore */
        }
      }, 0);
    }

    function closeChat() {
      inputAnchor.hidden = true;
      input.value = '';
      chatBusy = false;
      try {
        input.blur();
      } catch (_) {
        /* ignore */
      }
    }

    function sayWithSticker(text, stickerFile, ms) {
      if (stickerFile) {
        bubblePic.src = assetUrl(stickerFile);
        bubblePic.hidden = false;
      } else {
        bubblePic.hidden = true;
      }
      say(text, { ms: ms });
    }

    /** 发一次请求，把「HTTP 状态 + 解析后的 JSON」都拿回来，好在失败时给准确提示 */
    function postChat(text) {
      return fetch(ROUTE + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, history: chatHistory.slice(-6), avoidSticker: lastSticker }),
      }).then(function (res) {
        return res.text().then(function (raw) {
          var data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = null;
          }
          return { status: res.status, data: data };
        });
      });
    }

    var lastSticker = null;

    function sendChat() {
      var text = String(input.value || '').trim();
      if (!text || chatBusy) return;
      chatBusy = true;
      input.value = '';
      autosize();
      closeChat();
      sayWithSticker('…', null, 20000);

      postChat(text)
        .catch(function () {
          // 网络抖一下：等 700ms 再试一次
          return new Promise(function (resolve) {
            setTimeout(resolve, 700);
          }).then(function () {
            return postChat(text);
          });
        })
        .then(function (result) {
          var data = result.data;
          if (result.status === 404 || result.status === 405) {
            throw new Error('宿主还是旧版，重启 DSH 就好');
          }
          if (!data || data.ok !== true || !data.text) {
            throw new Error((data && data.message) || '宿主没给出回答');
          }
          chatHistory.push({ role: 'user', text: text });
          chatHistory.push({ role: 'cat', text: data.text });
          if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
          lastSticker = data.sticker || null;
          sayWithSticker(data.text, data.sticker || null, config.chatBubbleMs || 9000);
        })
        .catch(function (error) {
          say('对话失败：' + (error && error.message ? error.message : '连不上宿主'), { ms: 6000, error: true });
        })
        .then(function () {
          chatBusy = false;
        });
    }

    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        sendChat();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        closeChat();
      }
    });

    function onOutsideChat(event) {
      if (inputAnchor.hidden) return;
      // shadow DOM 里 event.target 会被重定向到宿主元素，得看 composedPath
      var path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.indexOf(inputAnchor) >= 0 || inputAnchor.contains(event.target)) return;
      closeChat();
    }
    document.addEventListener('pointerdown', onOutsideChat, true);

    function onPanelMessage(event) {
      var data = event.data;
      if (!data) return;
      if (data.source !== 'dsh-coke-outfit') return;
      if (data.type === 'skin-saved' || data.type === 'skin-reset') {
        if (hooks && typeof hooks.onSkinChanged === 'function') hooks.onSkinChanged();
      } else if (data.type === 'close') {
        closePanel();
      }
    }
    window.addEventListener('message', onPanelMessage);

    root.appendChild(bubbleAnchor);
    root.appendChild(inputAnchor);
    root.appendChild(stage);
    root.appendChild(bal);
    root.appendChild(menu);
    root.appendChild(modal);
    shadow.appendChild(style);
    shadow.appendChild(root);
    targetBody.appendChild(host);
    console.info('[dsh-coke] overlay mounted', { size: config.size });

    // 贴图：默认用包里那张，宿主说换了形象就用自定义的
    var unsubscribeSkin = subscribeSkin(function (url) {
      cat.src = url || assetUrl('cat.png');
    });
    cat.src = skinValue || assetUrl('cat.png');

    // ---- 台词 + 语音：点一下按权重抽一句 ----
    // 合计 100：我痞吗 40%，其余 6 句各 10%
    var VOICES = [
      { file: 'piqi.wav', fallback: 'piqi.mp3', text: '我痞吗？', weight: 40, volume: 0.95 },
      { file: 'miao.wav', text: '喵喵喵', weight: 10, volume: 1 },
      { file: 'bifeng.wav', text: '避我锋芒', weight: 10 },
      { file: 'nvwa.wav', text: '约女娲', weight: 10 },
      { file: 'zhuanzhu.wav', text: '绝对专注', weight: 10 },
      { file: 'amatelas.wav', text: '阿马特拉斯', weight: 10 },
      { file: 'shunen.wav', text: '舒嫩', weight: 10 },
    ];
    var voicePool = {};

    // ---- 形态展示：头顶卡片随机放一张 coke 形态图 + 「我痞吗」语音，1 分钟后自动收 ----
    var FORMS = [];
    for (var fi = 1; fi <= 18; fi += 1) {
      FORMS.push('coke-' + (fi < 10 ? '0' + fi : String(fi)) + '.jpg');
    }
    var formTimer = 0;
    var formOn = false;

    function hideForm() {
      if (formTimer) clearTimeout(formTimer);
      formTimer = 0;
      if (!formOn) return;
      formOn = false;
      formAnchor.classList.remove('on');
      if (hooks && typeof hooks.onFormOpen === 'function') hooks.onFormOpen(false);
    }

    function showForm() {
      if (dead) return;
      // 卡片要占头顶，把正在显示的台词气泡先收掉，别叠在一起
      if (bubbleTimer) clearTimeout(bubbleTimer);
      bubbleTimer = 0;
      bubble.classList.remove('cc-show');
      var file = FORMS[Math.floor(Math.random() * FORMS.length)];
      formImg.src = assetUrl(file);
      formCaption.textContent = '我痞吗';
      formAnchor.classList.add('on');
      formOn = true;
      clearTimeout(formTimer);
      var ms = config.formMs || 60000;
      formTimer = setTimeout(hideForm, ms);
      // 出现的同时放「我痞吗」那句
      play(voiceEl(VOICES[0]));
      if (hooks && typeof hooks.onFormOpen === 'function') hooks.onFormOpen(true);
    }

    /** 用到才建 Audio，7 条素材不会在挂载时一起下载。 */
    function voiceEl(entry) {
      if (voicePool[entry.file]) return voicePool[entry.file];
      var el = new Audio(assetUrl(entry.file));
      el.preload = 'none';
      el.volume = typeof entry.volume === 'number' ? entry.volume : 0.9;
      if (entry.fallback) {
        el.addEventListener('error', function () {
          el.src = assetUrl(entry.fallback);
        });
      }
      voicePool[entry.file] = el;
      return el;
    }

    /** 按权重抽一条（Math.random 只在 [0,1) 上取值，权重和不用是 100）。 */
    function pickVoice() {
      var total = 0;
      for (var i = 0; i < VOICES.length; i += 1) total += VOICES[i].weight;
      var roll = Math.random() * total;
      for (var j = 0; j < VOICES.length; j += 1) {
        roll -= VOICES[j].weight;
        if (roll < 0) return VOICES[j];
      }
      return VOICES[0];
    }

    var shot = new Audio(assetUrl('shot.wav'));
    shot.preload = 'auto';
    shot.volume = 1;

    var bubbleTimer = 0;
    function say(text, opts) {
      // 形态展示卡片占着头顶时不弹普通气泡，免得两个东西叠在一起
      if (formOn) return;
      bubble.textContent = text;
      bubble.classList.toggle('cc-error', !!(opts && opts.error));
      bubble.classList.add('cc-show');
      clearTimeout(bubbleTimer);
      var ms = (opts && opts.ms) || config.bubbleMs || 1600;
      bubbleTimer = setTimeout(function () {
        bubble.classList.remove('cc-show');
      }, ms);
    }

    function play(audio, volume) {
      try {
        if (typeof volume === 'number') audio.volume = volume;
        audio.currentTime = 0;
        var p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (_) {
        /* 拒绝播放就静默 */
      }
    }

    // ---- 唱歌：掏麦克风 + 两首（80% / 20%） ----
    var singA = new Audio(assetUrl('sing1.m4a')); // 80% 的那首
    singA.preload = 'none';
    singA.volume = 0.9;
    var singB = new Audio(assetUrl('sing2.m4a')); // 20% 的那首
    singB.preload = 'none';
    singB.volume = 0.9;
    var singing = null;

    function updateMenuLabels() {
      singEntry.text.textContent = singing ? '停止唱歌' : '唱歌';
    }

    function stopSing() {
      if (singing) {
        try {
          singing.pause();
          singing.currentTime = 0;
        } catch (_) {
          /* ignore */
        }
        singing = null;
      }
      mic.classList.remove('on');
      updateMenuLabels();
    }

    /** 80% 放第一首，20% 放第二首。 */
    function pickSong() {
      return Math.random() < 0.8 ? singA : singB;
    }

    function startSing() {
      stopSing();
      var track = pickSong();
      singing = track;
      mic.classList.add('on');
      say('🎤 我唱一首', { ms: 1800 });
      play(track);
      track.onended = function () {
        if (singing === track) stopSing();
      };
      updateMenuLabels();
    }

    function toggleSing() {
      if (singing) stopSing();
      else startSing();
    }

    // ---- Q 弹回弹 ----
    var y = 0;
    var vy = 0;
    var sx = 1;
    var vsx = 0;
    var raf = 0;
    var last = 0;
    var dead = false;

    function frame(now) {
      var dt = Math.min(Math.max((now - last) / 1000, 0), 1 / 30);
      last = now;
      vy += 3000 * dt;
      y += vy * dt;
      if (y > 0) {
        y = 0;
        vy = -vy * 0.34;
        if (Math.abs(vy) < 62) vy = 0;
      }
      var ax = -330 * (sx - 1) - 12.5 * vsx;
      vsx += ax * dt;
      sx += vsx * dt;
      var stretch = 1 + Math.min(Math.abs(vy) / 3400, 0.1);
      var sy = (1 / sx) * stretch;
      cat.style.transform =
        'translate3d(0,' + y.toFixed(2) + 'px,0) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
      // 气泡/形态卡片跟着脑袋走：跳跃位移 + 拉伸带来的高度变化（transform-origin 在底部，
      // 纵向放大时头顶会额外抬高 (sy-1)*size）。挂在 root 上，两个锚点都能继承。
      root.style.setProperty('--cc-hop', (y - (sy - 1) * (config.size >>> 0)).toFixed(2) + 'px');
      if (y === 0 && vy === 0 && Math.abs(sx - 1) < 0.0015 && Math.abs(vsx) < 0.02) {
        cat.style.transform = '';
        root.style.setProperty('--cc-hop', '0px');
        raf = 0;
        y = 0;
        vy = 0;
        sx = 1;
        vsx = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    function kick() {
      y = 0;
      vy = -470;
      sx = 1.22;
      vsx = 0;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    }

    function onCatClick() {
      if (dead) return;
      kick();
      var entry = pickVoice();
      play(voiceEl(entry));
      say(entry.text);
    }

    // ---- 右键菜单 ----
    function closeMenu() {
      menu.hidden = true;
      window.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('keydown', onEsc, true);
    }

    function onOutside(event) {
      if (event.composedPath && event.composedPath().indexOf(menu) >= 0) return;
      closeMenu();
    }

    function onEsc(event) {
      if (event.key === 'Escape') closeMenu();
    }

    function openMenu(x, yy) {
      updateMenuLabels();
      menu.hidden = false;
      var rect = menu.getBoundingClientRect();
      var left = Math.min(Math.max(6, x), Math.max(6, window.innerWidth - rect.width - 6));
      var top = Math.min(Math.max(6, yy), Math.max(6, window.innerHeight - rect.height - 6));
      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(top) + 'px';
      window.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('keydown', onEsc, true);
    }

    function onContextMenu(event) {
      if (dead) return;
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.clientX, event.clientY);
    }

    // ---- 枪击：枪声 + 倒下淡出 + 停止运行 ----
    function shoot() {
      if (dead) return;
      dead = true;
      closeMenu();
      stopSing();
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      play(shot, 0.9);
      cat.style.transition = 'transform .5s cubic-bezier(.3,.9,.4,1), opacity .75s ease .15s';
      cat.style.transformOrigin = '50% 85%';
      cat.style.transform = 'translate3d(0, 10px, 0) rotate(74deg)';
      cat.style.opacity = '0';
      bal.style.transition = 'opacity .35s ease';
      bal.style.opacity = '0';
      bubble.classList.remove('cc-show');
      // 「形态展示」卡片也挂在头顶，一起收掉 —— 不然猫都倒下了卡片还挂着
      hideForm();
      formAnchor.style.transition = 'opacity .25s ease';
      formAnchor.style.opacity = '0';
      setTimeout(function () {
        if (hooks && typeof hooks.onDead === 'function') hooks.onDead();
      }, 900);
    }

    // ---- 拖动 ----
    var drag = null;

    function onPointerDown(event) {
      if (dead) return;
      if (event.button !== undefined && event.button !== 0) return;
      var rect = root.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      cat.classList.add('cc-dragging');
      try {
        cat.setPointerCapture(event.pointerId);
      } catch (_) {
        /* 没有 pointer capture 也能拖 */
      }
      event.preventDefault();
    }

    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.id) return;
      var dx = event.clientX - drag.startX;
      var dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
      if (!drag.moved) return;
      applyPos(drag.left + dx, drag.top + dy);
    }

    function onPointerUp(event) {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      var wasDragging = drag.moved;
      var rect = root.getBoundingClientRect();
      drag = null;
      cat.classList.remove('cc-dragging');
      if (!wasDragging) {
        onCatClick();
        return;
      }
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (_) {
        /* 隐私模式下写不了就算了 */
      }
    }

    function onSingClick(event) {
      event.stopPropagation();
      if (dead) return;
      closeMenu();
      toggleSing();
    }

    function onChatClick(event) {
      event.stopPropagation();
      closeMenu();
      openChat();
    }

    function onFormClick(event) {
      event.stopPropagation();
      closeMenu();
      showForm();
    }

    function onOutfitClick(event) {
      event.stopPropagation();
      closeMenu();
      openPanel();
    }

    cat.addEventListener('pointerdown', onPointerDown);
    cat.addEventListener('pointermove', onPointerMove);
    cat.addEventListener('pointerup', onPointerUp);
    cat.addEventListener('pointercancel', onPointerUp);
    cat.addEventListener('contextmenu', onContextMenu);
    shootItem.addEventListener('click', shoot);
    singItem.addEventListener('click', onSingClick);
    formItem.addEventListener('click', onFormClick);
    chatItem.addEventListener('click', onChatClick);
    outfitItem.addEventListener('click', onOutfitClick);

    // ---- 余额 ----
    var balanceCache = null;
    var balanceAt = 0;

    function renderBalance(result) {
      if (result && result.ok) {
        bal.dataset.state = 'ok';
        bal.textContent = '余额 ' + result.amount;
        bal.title = result.source + ' · 赠金 ¥' + result.granted + ' · 充值 ¥' + result.toppedUp;
        say('余额 ' + result.amount, { ms: 2600 });
      } else {
        bal.dataset.state = 'error';
        bal.textContent = '余额查不了';
        var msg = (result && result.message) || '余额查询失败';
        bal.title = msg;
        say(msg, { ms: 3200, error: true });
      }
    }

    function fetchBalance(force) {
      var fresh = balanceCache && Date.now() - balanceAt < 60000 && !force;
      if (fresh) {
        renderBalance(balanceCache);
        return;
      }
      bal.dataset.state = 'loading';
      bal.textContent = '查询中…';
      fetch(ROUTE + '/balance', { cache: 'no-store' })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          balanceCache = data;
          balanceAt = Date.now();
          renderBalance(data);
        })
        .catch(function (error) {
          renderBalance({
            ok: false,
            message: '余额接口请求失败：' + (error && error.message ? error.message : String(error)),
          });
        });
    }

    function onBalClick(event) {
      event.stopPropagation();
      if (dead) return;
      fetchBalance(true);
    }

    bal.addEventListener('click', onBalClick);

    return function unmount() {
      clearTimeout(bubbleTimer);
      if (raf) cancelAnimationFrame(raf);
      cat.removeEventListener('pointerdown', onPointerDown);
      cat.removeEventListener('pointermove', onPointerMove);
      cat.removeEventListener('pointerup', onPointerUp);
      cat.removeEventListener('pointercancel', onPointerUp);
      cat.removeEventListener('contextmenu', onContextMenu);
      shootItem.removeEventListener('click', shoot);
      singItem.removeEventListener('click', onSingClick);
      outfitItem.removeEventListener('click', onOutfitClick);
      formItem.removeEventListener('click', onFormClick);
      chatItem.removeEventListener('click', onChatClick);
      input.removeEventListener('input', autosize);
      document.removeEventListener('pointerdown', onOutsideChat, true);
      if (formTimer) clearTimeout(formTimer);
      formTimer = 0;
      formOn = false;
      modalClose.removeEventListener('click', closePanel);
      window.removeEventListener('message', onPanelMessage);
      unsubscribeSkin();
      bal.removeEventListener('click', onBalClick);
      window.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('keydown', onEsc, true);
      try {
        for (var key in voicePool) {
          var el = voicePool[key];
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
        voicePool = {};
        shot.pause();
        shot.removeAttribute('src');
        shot.load();
        singA.pause();
        singB.pause();
        singA.removeAttribute('src');
        singB.removeAttribute('src');
        singA.load();
        singB.load();
      } catch (_) {
        /* ignore */
      }
      host.remove();
    };
  }

  // ---------------------------------------------------------------------------
  // 设置页「小猫coke」
  // ---------------------------------------------------------------------------
  function makeSection(react) {
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    // 全部写成带单位的字符串：数字在部分渲染器里不一定会自动补 px
    function buttonStyle(active, danger) {
      return {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        minHeight: '30px',
        padding: '5px 14px',
        borderRadius: '8px',
        border: danger
          ? '1px solid rgba(255,120,120,.6)'
          : active
            ? '1px solid rgba(120,200,255,.75)'
            : '1px solid rgba(127,127,127,.4)',
        background: danger
          ? 'rgba(255,120,120,.16)'
          : active
            ? 'rgba(120,200,255,.20)'
            : 'transparent',
        color: danger ? '#ff9d9d' : 'inherit',
        fontFamily: 'inherit',
        fontSize: '13px',
        fontWeight: 600,
        cursor: 'pointer',
      };
    }
    var muted = { opacity: 0.72, fontSize: '12.5px', lineHeight: 1.6, margin: '0' };

    return function CokeCatSection() {
      var pair = useState(snapshot());
      var st = pair[0];
      var setSt = pair[1];
      var confirmPair = useState(false);
      var confirming = confirmPair[0];
      var setConfirming = confirmPair[1];

      useEffect(function () {
        return subscribe(setSt);
      }, []);

      useEffect(function () {
        if (!confirming) return undefined;
        var timer = setTimeout(function () {
          setConfirming(false);
        }, 5000);
        return function () {
          clearTimeout(timer);
        };
      }, [confirming]);

      var statusText;
      if (!st.loaded) statusText = '正在读取状态…';
      else if (st.mode === 'desktop') {
        statusText = st.desktop.running
          ? '正在桌面窗口运行：屏幕右下角那个透明小窗就是它（置顶、不进任务栏）'
          : '桌面窗口正在启动…（起不来会自动退回页面内）';
      } else if (st.mode === 'inline') statusText = '正在页面内运行：DSH 窗口右下角那只猫';
      else statusText = '已关闭（被枪击或手动关掉），点「桌面窗口」或「页面内」叫回来';

      var modeLabel = st.mode === 'desktop' ? '桌面窗口' : st.mode === 'inline' ? '页面内' : '已关闭';

      var children = [
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
          h('span', { key: 'title', style: { fontSize: '15px', fontWeight: 700 } }, TITLE),
          h(
            'span',
            {
              key: 'badge',
              style: {
                fontSize: '11.5px',
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(127,127,127,.35)',
                opacity: 0.85,
              },
            },
            modeLabel,
          ),
        ),
        h('p', { key: 'status', style: Object.assign({}, muted, { marginBottom: '12px' }) }, statusText),
        h(
          'div',
          { key: 'modes', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' } },
          h(
            'button',
            {
              key: 'desktop',
              type: 'button',
              style: buttonStyle(st.mode === 'desktop'),
              disabled: st.busy,
              onClick: function () {
                switchMode('desktop');
              },
            },
            '桌面窗口',
          ),
          h(
            'button',
            {
              key: 'inline',
              type: 'button',
              style: buttonStyle(st.mode === 'inline'),
              disabled: st.busy,
              onClick: function () {
                switchMode('inline');
              },
            },
            '页面内',
          ),
          h(
            'button',
            {
              key: 'off',
              type: 'button',
              style: buttonStyle(st.mode === 'off'),
              disabled: st.busy,
              onClick: function () {
                switchMode('off');
              },
            },
            '关闭',
          ),
        ),
        h(
          'div',
          { key: 'actions', style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' } },
          h(
            'button',
            {
              key: 'reset',
              type: 'button',
              style: buttonStyle(false),
              disabled: st.busy,
              onClick: function () {
                resetPosition();
                setMessage('位置已重置：页面内的猫立刻回右下角；桌面窗口下次启动回右下角');
              },
            },
            '重置位置',
          ),
          h(
            'button',
            {
              key: 'uninstall',
              type: 'button',
              style: buttonStyle(false, confirming),
              disabled: st.busy,
              onClick: function () {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                setConfirming(false);
                requestUninstall();
              },
            },
            confirming ? '确认卸载？' : '卸载',
          ),
        ),
        h(
          'p',
          { key: 'hint', style: muted },
          '左键点猫：弹「我痞吗？」；右键点猫：可以「枪击小猫」；按住拖动可以换位置。桌面窗口模式下也能拖动窗口。',
        ),
      ];

      if (st.desktop && st.desktop.error) {
        children.push(
          h('p', { key: 'derror', style: Object.assign({}, muted, { marginTop: '8px', color: '#ffb3b3' }) },
            '桌面窗口：' + st.desktop.error),
        );
      }
      if (st.lastError) {
        children.push(
          h('p', { key: 'lerror', style: Object.assign({}, muted, { marginTop: '8px', color: '#ffb3b3' }) },
            '上次启动失败：' + st.lastError),
        );
      }
      if (st.message) {
        children.push(
          h(
            'p',
            { key: 'msg', style: Object.assign({}, muted, { marginTop: '8px', color: '#8fe0a8' }) },
            st.message,
          ),
        );
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', padding: '4px 2px' } }, children);
    };
  }

  function makeFactory() {
    return function (require) {
      var module = { exports: {} };

      var react = null;
      try {
        react = require('react');
      } catch (error) {
        console.warn('[dsh-coke] react 不可用，设置页不会注册：' + (error && error.message));
      }

      function apply(ctx) {
        var disposed = false;
        var disposer = null;

        function render() {
          if (disposed) return;
          if (!document.body) return;
          if (state.mode === 'inline') {
            if (!disposer) {
              disposer = mount(document.body, state.appearance, {
                onDead: function () {
                  switchMode('off');
                },
                onSkinChanged: function () {
                  void refreshConfig();
                },
              });
            }
          } else if (disposer) {
            disposer();
            disposer = null;
          }
        }

        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            var unsubscribe = subscribe(render);
            return function () {
              unsubscribe();
              disposed = true;
              if (disposer) disposer();
              disposer = null;
            };
          }, 'dsh-coke: overlay follows mode');
        } else {
          subscribe(render);
        }

        // 先按“页面内”挂上（真出问题时至少还有猫），配置回来再按 host 的模式收掉
        render();
        void refreshConfig();

        if (react && ctx && ctx.slots && typeof ctx.slots.inject === 'function') {
          try {
            var Section = makeSection(react);
            ctx.slots.inject('settings.section', function* () {
              yield ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'coke',
                  order: 40,
                  label: function () {
                    return TITLE;
                  },
                },
                Section,
              );
            });
          } catch (error) {
            console.warn('[dsh-coke] 设置页分区注册失败：' + (error && error.message));
          }
        }
      }

      module.exports = {
        name: 'coke',
        inject: react ? ['slots'] : [],
        apply: apply,
      };
      return module.exports;
    };
  }

  var loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
  if (!loader || typeof loader.load !== 'function') {
    if (typeof window !== 'undefined') window.__dshCokeCatFactory__ = makeFactory;
    return;
  }
  loader.load({ id: PLUGIN_ID, factory: makeFactory() });
})();
