const { app, BrowserWindow, ipcMain, screen } = require('electron');

// 注意：不要 disableHardwareAcceleration——纯软件合成器画不出透明窗口（全透明=看不见）
// GPU 崩溃风险由启动参数 --use-angle=swiftshader 规避（软件 GL，支持透明合成）

let win = null;

const WIN_H = 330;   // 容纳 300px 高的小人 + 余量
// 统一的地面计算：站在地面时窗口顶边 y（workArea.y 在部分多屏/任务栏布局下非 0，不能漏加）
function groundY() {
  const wa = screen.getPrimaryDisplay().workArea;
  return wa.y + wa.height - WIN_H;
}
// 诊断：把坐标账记进 render.log，排查"回到地面偏低"
function logGeo(tag) {
  try {
    const d = screen.getPrimaryDisplay();
    mlog(tag + ': bounds=' + JSON.stringify(d.bounds) + ' workArea=' + JSON.stringify(d.workArea) +
         ' scaleFactor=' + d.scaleFactor + ' win=' + (win ? JSON.stringify(win.getBounds()) : 'null') +
         ' groundY=' + groundY());
  } catch (e) {}
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: 0,
    y: groundY(),
    width: width,
    height: WIN_H,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,   // 无边框窗口没有可拖的边框；且 Windows 对 resizable:false 的 setBounds 有尺寸怪癖
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');
  // 渲染进程日志/报错转发到文件（排查黑屏用）
  const fs = require('fs');
  const logStream = fs.createWriteStream(require('path').join(__dirname, 'render.log'), { flags: 'a' });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    // 兼容新旧 Electron 事件签名（新版把 level/message 等挂在 event 对象上）
    if (message === undefined && e && typeof e === 'object') {
      level = e.level; message = e.message; line = e.lineNumber; sourceId = e.sourceId;
    }
    logStream.write(new Date().toISOString() + ' [L' + level + '] ' + message + ' @' + sourceId + ':' + line + '\n');
  });
  win.webContents.on('render-process-gone', (e, details) => {
    logStream.write(new Date().toISOString() + ' [GONE] ' + JSON.stringify(details) + '\n');
  });
  win.on('closed', () => { win = null; });
  logGeo('boot');
}

// ---- 窗口定位：一律走 setBounds 全量设置 ----
// 坑：Windows + 非整数 DPI 缩放下，对 resizable:false 的无边框窗口反复 setPosition，
// DIP↔物理像素舍入误差会逐次累积，窗口被越撑越高（330 → 400+），精灵随 clientHeight
// 下移 = "回到地面后越沉越低"。setBounds 显式锁死宽高，每次调用都纠正回 WIN_H。
function placeWindow(y) {
  if (!win || win.isDestroyed()) return;
  const width = screen.getPrimaryDisplay().workArea.width;
  win.setBounds({ x: 0, y: Math.round(y), width: Math.round(width), height: WIN_H });
}

ipcMain.on('set-ignore', (e, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

// ---- 拖拽：主进程轮询光标，移动的是"她本人"的坐标，精灵永远钳制在工作区内 ----
let dragTimer = null;
ipcMain.on('drag-start', (e, g) => {
  if (!win) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const sw = wa.width, sh = wa.height;
  // 告诉渲染进程工作区高度，赐福要钉在真实地面用
  win.webContents.send('screen-info', sh);
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(dragTimer); dragTimer = null; return; }
    const c = screen.getCursorScreenPoint();
    // 期望的精灵左上角位置（屏幕坐标），四边钳制在工作区内
    const sx = Math.max(0, Math.min(c.x - g.gx, sw - g.dw));
    const sy = Math.max(wa.y, Math.min(c.y - g.gy, wa.y + sh - g.dh));
    // 窗口全宽固定 x=0，竖直方向=精灵顶 - 精灵在窗口内的偏移
    placeWindow(Math.round(sy - g.floor));
    if (!win.isDestroyed()) win.webContents.send('drag-pos', Math.round(sx), Math.round(sy - g.floor));
  }, 16);
});
ipcMain.on('drag-end', () => {
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
});

// ---- 设置菜单 ----
ipcMain.on('go-home', () => {
  if (!win) return;
  const ny = groundY();   // 与启动时同一套地面算法，不会偏低/偏高
  placeWindow(ny);
  win.webContents.send('set-winy', ny);   // 同步窗口坐标，赐福保持钉在地面
  logGeo('go-home');
});
ipcMain.on('quit-app', () => app.quit());

// ---- 本地模型大脑（llm_worker.js 子进程 + node-llama-cpp，纯离线，不发任何网络请求） ----
const path = require('path');
// 主进程日志落盘（GUI 程序 stdout 不可见，方便排查）
function mlog(msg) {
  try {
    require('fs').appendFileSync(
      require('path').join(__dirname, 'render.log'),
      new Date().toISOString() + ' [MAIN] ' + msg + '\n'
    );
  } catch (e) {}
}

let worker = null;        // LLM 子进程（electron 以 node 模式运行，隔离 native 崩溃）
let workerReady = false;
let workerInitError = null;       // 如模型文件缺失
const pendingChats = new Map();   // id -> resolve
let reqId = 0;

function startWorker() {
  if (worker) return worker;
  mlog('LLM: starting worker');
  const w = require('child_process').spawn(
    process.execPath,
    [require('path').join(__dirname, 'llm_worker.js')],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let buf = '';
  w.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.type === 'ready') {
        workerReady = true;
        workerInitError = null;
        mlog('LLM: worker ready');
      } else if (msg.type === 'error') {
        workerInitError = msg.error;
        mlog('LLM: worker init error: ' + msg.error);
      } else if (msg.type === 'reply' && pendingChats.has(msg.id)) {
        pendingChats.get(msg.id)(msg.ok ? { ok: true, reply: msg.reply } : { ok: false, error: msg.error });
        pendingChats.delete(msg.id);
      }
    }
  });
  w.stderr.on('data', (d) => mlog('LLM worker stderr: ' + d.toString().slice(0, 300)));
  w.on('exit', (code) => {
    mlog('LLM: worker exited code ' + code);
    if (worker === w) { worker = null; workerReady = false; }
    for (const [id, resolve] of pendingChats) {
      resolve({ ok: false, error: '模型进程退出，请重试' });
      pendingChats.delete(id);
    }
  });
  worker = w;
  return w;
}

// 启动后预热（renderer 加载完就调），首次聊天不用等模型加载
ipcMain.on('llm-preload', () => {
  mlog('LLM: preload requested');
  startWorker();
});
ipcMain.handle('chat-llm', async (e, userText) => {
  // 模型文件缺失等初始化错误，直接给出可读提示
  if (workerInitError) {
    const miss = workerInitError.indexOf('ENOENT') >= 0 || workerInitError.indexOf('no such file') >= 0;
    return { ok: false, error: miss ? 'MODEL_MISSING' : workerInitError };
  }
  const w = startWorker();
  const id = ++reqId;
  return await new Promise((resolve) => {
    pendingChats.set(id, resolve);
    try {
      w.stdin.write(JSON.stringify({ id, text: String(userText || '……') }) + '\n');
    } catch (err) {
      pendingChats.delete(id);
      resolve({ ok: false, error: '模型进程未响应' });
      return;
    }
    // 2 分钟兜底超时
    setTimeout(() => {
      if (pendingChats.has(id)) {
        pendingChats.delete(id);
        resolve({ ok: false, error: '回复超时' });
      }
    }, 120000);
  });
});
app.on('before-quit', () => { if (worker) { try { worker.kill(); } catch (e) {} worker = null; } });

// 单实例锁：防止双击两次 bat 跑出两只梅琳娜
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
