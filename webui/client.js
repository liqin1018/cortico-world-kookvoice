/**
 * KOOK 语音面板。
 *
 * 布局参照 GPTSoVits 插件：上面一条状态带，中间分页签，下面内容区。
 * 数据全部来自 ctx.invoke('state')，不自己存一份 —— 两份状态迟早对不上。
 */

const CSS = `
.kv { --line: rgba(128,128,128,.18); --soft: rgba(128,128,128,.08);
      display:flex; flex-direction:column; padding:0; font-size:13px;
      line-height:1.62; color:inherit; }

/* 状态带 */
.kv-bar { display:flex; align-items:center; gap:10px; padding:14px 18px 12px; }
.kv-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; background:#b0b4b8; }
.kv-dot.on  { background:#2fa36b; box-shadow:0 0 0 3px rgba(47,163,107,.16); }
.kv-dot.wait{ background:#e0a13a; box-shadow:0 0 0 3px rgba(224,161,58,.16); }
.kv-dot.err { background:#d9534f; box-shadow:0 0 0 3px rgba(217,83,79,.16); }
.kv-name { font-weight:600; font-size:14px; }
.kv-sep { opacity:.4; }
.kv-state { opacity:.75; }
.kv-grow { flex:1 1 auto; }

.kv-btn { font:inherit; font-size:12.5px; padding:6px 16px; border-radius:7px; cursor:pointer;
          border:1px solid var(--line); background:transparent; color:inherit; white-space:nowrap; }
.kv-btn:hover:not(:disabled) { background:var(--soft); }
.kv-btn:disabled { opacity:.4; cursor:default; }
.kv-btn.primary { background:#2f6fed; border-color:#2f6fed; color:#fff; }
.kv-btn.primary:hover:not(:disabled) { background:#255fd6; }

/* 页签 */
.kv-tabs { display:flex; gap:2px; padding:0 18px; border-bottom:1px solid var(--line); }
.kv-tab { font:inherit; font-size:13px; padding:8px 14px; border:0; background:transparent;
          color:inherit; opacity:.6; cursor:pointer; border-bottom:2px solid transparent;
          margin-bottom:-1px; }
.kv-tab:hover { opacity:.9; }
.kv-tab.on { opacity:1; font-weight:600; border-bottom-color:#2f6fed; }

/* 内容 */
.kv-body { padding:16px 18px 20px; display:flex; flex-direction:column; gap:18px; }
.kv-sec { display:flex; flex-direction:column; gap:8px; }
.kv-h { font-size:12px; font-weight:600; opacity:.55; }

.kv-grid { display:grid; grid-template-columns:76px 1fr; gap:7px 14px; }
.kv-k { opacity:.55; }
.kv-v { word-break:break-all; }

.kv-log { margin:0; padding:10px 12px; max-height:230px; overflow:auto; border-radius:8px;
          background:var(--soft); font-family:ui-monospace,Consolas,monospace;
          font-size:11.5px; line-height:1.6; white-space:pre-wrap; }

.kv-err { color:#c0392b; background:rgba(217,83,79,.08); border-left:3px solid #d9534f;
          padding:8px 12px; border-radius:6px; white-space:pre-wrap; font-size:12.5px; }

.kv-row { display:flex; gap:8px; align-items:center; }
.kv-input { flex:1 1 auto; font:inherit; font-size:13px; padding:7px 11px; border-radius:7px;
            border:1px solid var(--line); background:transparent; color:inherit; }
.kv-input:focus { outline:none; border-color:#2f6fed; }
.kv-hint { font-size:12px; opacity:.55; }
.kv-msg { font-size:12.5px; padding:6px 10px; border-radius:6px; background:var(--soft); }

.kv-tree { display:flex; flex-direction:column; gap:2px; }
.kv-group { font-size:12px; opacity:.6; margin-top:7px; }
.kv-ch { display:flex; align-items:baseline; gap:8px; padding:6px 10px; border-radius:7px;
         cursor:pointer; border:1px solid transparent; }
.kv-ch:hover { background:var(--soft); }
.kv-ch.on { background:rgba(47,111,237,.10); border-color:#2f6fed; }
.kv-ch .cid { font-size:11px; opacity:.4; font-family:ui-monospace,Consolas,monospace; }
.kv-pick { font-size:12px; opacity:.6; }
.kv-fetch { margin-top:9px; width:100%; }
.kv-h-row { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.kv-h-row .kv-btn { padding:3px 10px; font-size:12px; }

.kv-env { display:flex; flex-direction:column; gap:2px; }
.kv-item { display:grid; grid-template-columns:18px 1fr auto; gap:9px; align-items:baseline;
           padding:7px 2px; border-bottom:1px solid var(--line); }
.kv-item:last-child { border-bottom:0; }
.kv-ico { font-size:12px; line-height:1; }
.kv-ico.ok { color:#2fa36b; }
.kv-ico.no { color:#d9534f; }
.kv-iname { font-weight:500; }
.kv-idetail { grid-column:2 / 4; font-size:11.5px; opacity:.55; word-break:break-all;
              font-family:ui-monospace,Consolas,monospace; }
.kv-ihint { grid-column:2 / 4; font-size:11.5px; opacity:.45; }
`;

const PHASE = {
  idle: ['未连接', ''],
  starting: ['正在进频道…', 'wait'],
  listening: ['在听', 'on'],
  error: ['出错了', 'err'],
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** 读状态。已确认框架调的是 state（早期为了兼容猜过三个名字，没必要了）。 */
async function pull(ctx) {
  try {
    const out = await ctx.invoke('state');
    return out && typeof out === 'object' ? out : null;
  } catch {
    return null;
  }
}

function mount(ctx) {
  const root = ctx.root;
  root.textContent = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  root.append(style);

  const app = el('div', 'kv');
  root.append(app);

  // ── 状态带 ────────────────────────────────────────────────
  const bar = el('div', 'kv-bar');
  const dot = el('span', 'kv-dot');
  const name = el('span', 'kv-name', 'KOOK 语音');
  const sep = el('span', 'kv-sep', '·');
  const stateText = el('span', 'kv-state', '未连接');
  const grow = el('span', 'kv-grow');
  const btnJoin = el('button', 'kv-btn primary', '进频道');
  const btnLeave = el('button', 'kv-btn', '退频道');
  btnJoin.type = 'button';
  btnLeave.type = 'button';
  bar.append(dot, name, sep, stateText, grow, btnJoin, btnLeave);

  // ── 页签 ──────────────────────────────────────────────────
  const tabs = el('div', 'kv-tabs');
  const TB = [
    ['conn', '连接'],
    ['test', '试听'],
    ['env', '环境'],
  ];
  const tabBtns = new Map();
  for (const [id, label] of TB) {
    const b = el('button', 'kv-tab', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      tab = id;
      render();
    });
    tabBtns.set(id, b);
    tabs.append(b);
  }

  // ── 连接页 ────────────────────────────────────────────────
  const pageConn = el('div', 'kv-body');

  // 频道检测：不让人抄 ID —— 输入服务器短号/名字点一下，把频道树列出来选
  const pickSec = el('div', 'kv-sec');
  pickSec.append(el('div', 'kv-h', '频道'));

  // 令牌：没有它连 API 都调不通，所以放在最前面
  const tokenRow = el('div', 'kv-row');
  const tokenInput = el('input', 'kv-input');
  tokenInput.type = 'password';
  tokenInput.placeholder = 'KOOK 机器人令牌';
  const btnSaveToken = el('button', 'kv-btn', '保存');
  btnSaveToken.type = 'button';
  tokenRow.append(tokenInput, btnSaveToken);
  const tokenHint = el('div', 'kv-pick', '没填令牌的话检测和进频道都会失败。令牌在 KOOK 开发者后台 → 你的应用 → 机器人 → Token。');
  pickSec.append(tokenRow, tokenHint);

  const pickRow = el('div', 'kv-row');
  const pickInput = el('input', 'kv-input');
  pickInput.type = 'text';
  pickInput.placeholder = '服务器 ID / 8 位短号 / 名字（留空自动）';
  const btnDetect = el('button', 'kv-btn', '检测');
  btnDetect.type = 'button';
  pickRow.append(pickInput, btnDetect);
  const treeBox = el('div', 'kv-tree');
  const pickMsg = el('div', 'kv-pick', '点「检测」把服务器里的语音频道列出来');
  pickSec.append(pickRow, treeBox, pickMsg);

  const errBox = el('div', 'kv-err');
  errBox.style.display = 'none';

  const info = el('div', 'kv-sec');
  info.append(el('div', 'kv-h', '连接信息'));
  const grid = el('div', 'kv-grid');
  const cell = (k) => {
    const v = el('div', 'kv-v', '—');
    grid.append(el('div', 'kv-k', k), v);
    return v;
  };
  const vChannel = cell('频道');
  const vVoice = cell('音色');
  const vTts = cell('嗓子');
  const vBrain = cell('回答者');
  info.append(grid);

  const logSec = el('div', 'kv-sec');
  logSec.append(el('div', 'kv-h', '引擎输出'));
  const logBox = el('pre', 'kv-log', '（还没有输出）');
  logSec.append(logBox);

  pageConn.append(pickSec, errBox, info, logSec);

  // ── 试听页 ────────────────────────────────────────────────
  const pageTest = el('div', 'kv-body');
  const testSec = el('div', 'kv-sec');
  testSec.append(el('div', 'kv-h', '让她说一句'));
  const row = el('div', 'kv-row');
  const input = el('input', 'kv-input');
  input.type = 'text';
  input.placeholder = '输入一句话，她在语音频道里念出来';
  input.value = '你好呀，我现在可以在 KOOK 里说话了。';
  const btnSay = el('button', 'kv-btn primary', '让她说');
  btnSay.type = 'button';
  row.append(input, btnSay);
  const testMsg = el('div', 'kv-msg');
  testMsg.style.display = 'none';
  testSec.append(
    row,
    testMsg,
    el('div', 'kv-hint', '走的是同一个引擎和同一个嗓子 —— 这句念得出来，频道里就说得出来。'),
  );
  pageTest.append(testSec);

  // ── 环境页 ────────────────────────────────────────────────
  const pageEnv = el('div', 'kv-body');
  const envSec = el('div', 'kv-sec');
  envSec.append(el('div', 'kv-h', '环境检查'));
  const envList = el('div', 'kv-env');
  const envAdvice = el('div', 'kv-msg');
  envAdvice.textContent = '正在检查…';
  // 缺模型时这按钮才出现；点一次就下 225 MB，下好了它会自己消失
  const btnFetch = el('button', 'kv-btn kv-fetch', '下载依赖（约 225 MB）');
  btnFetch.type = 'button';
  btnFetch.style.display = 'none';
  // 手动重新检查：下完了点一下就知道对不对，不用切页签
  const btnEnvRefresh = el('button', 'kv-btn', '重新检查');
  btnEnvRefresh.type = 'button';
  const envHead = el('div', 'kv-h-row');
  envHead.append(el('div', 'kv-h', '环境检查'), btnEnvRefresh);
  envSec.append(envHead, envList, envAdvice, btnFetch);
  pageEnv.append(envSec);

  app.append(bar, tabs, pageConn, pageTest, pageEnv);

  let data = null;
  let tab = 'conn';
  let busy = false;
  let envData = null;
  let detectData = null;

  /** 把检测到的频道渲染成「分组 → 子频道」，当前选中的高亮 */
  function renderTree() {
    treeBox.textContent = '';
    if (!detectData) return;
    if (!detectData.ok) {
      pickMsg.textContent = '✗ ' + (detectData.error || '检测失败');
      return;
    }
    const cur = String(data?.channelId || detectData.current || '');
    for (const g of detectData.groups || []) {
      treeBox.append(el('div', 'kv-group', '📁 ' + g.name));
      for (const c of g.children || []) {
        const row = el('div', 'kv-ch' + (c.id === cur ? ' on' : ''));
        row.append(el('span', '', '🔊 ' + c.name), el('span', 'cid', c.id));
        row.addEventListener('click', () => void act('pick', [c.id, detectData.guild.id]));
        treeBox.append(row);
      }
    }
    pickMsg.textContent = cur
      ? `服务器：${detectData.guild.name}（短号 ${detectData.guild.openId || '-'}）`
      : `服务器：${detectData.guild.name} —— 选一个语音频道`;
  }

  async function doDetect() {
    if (!data?.hasToken && !tokenInput.value.trim()) {
      pickMsg.textContent = '先在上面填令牌 —— 没有它连不上 KOOK';
      return;
    }
    busy = true;
    render();
    pickMsg.textContent = '正在检测…';
    try {
      detectData = await ctx.invoke('detect', [pickInput.value.trim()]);
      renderTree();
    } catch (e) {
      pickMsg.textContent = '✗ ' + (e?.message ?? String(e));
    } finally {
      busy = false;
      render();
    }
  }

  function renderEnv() {
    if (!envData) return;
    envList.textContent = '';
    for (const it of envData.items || []) {
      const row = el('div', 'kv-item');
      row.append(
        el('span', 'kv-ico ' + (it.ok ? 'ok' : 'no'), it.ok ? '✓' : '✗'),
        el('span', 'kv-iname', it.name),
        el('span', 'kv-idetail', it.detail || ''),
      );
      if (it.hint) row.append(el('span', 'kv-ihint', it.hint));
      envList.append(row);
    }
    envAdvice.textContent = envData.advice || '';
    // 大件（ffmpeg + 模型）齐了就藏起来，缺才显示
    btnFetch.style.display = envData.ready ? 'none' : '';  }

  async function loadEnv(force = false) {
    // 切页签自动触发时节流（env() 里有 1.5s 超时的探测请求）
    // 手动点「重新检查」走 force，但防连点
    if (loadEnv.busy) return;
    if (!force && loadEnv.at && Date.now() - loadEnv.at < 10000) return;
    loadEnv.at = Date.now();
    loadEnv.busy = true;
    try {
      envData = await ctx.invoke('env');
      renderEnv();
    } catch (e) {
      envAdvice.textContent = '检查失败：' + (e?.message ?? String(e));
    } finally {
      loadEnv.busy = false;
    }
  }

  async function refreshEnv() {
    btnEnvRefresh.disabled = true;
    btnEnvRefresh.textContent = '检查中…';
    envAdvice.textContent = '正在检查…';
    try {
      await loadEnv(true);
    } finally {
      btnEnvRefresh.textContent = '重新检查';
      btnEnvRefresh.disabled = false;
    }
  }

  function render() {
    const phase = data?.phase ?? 'idle';
    const [label, cls] = PHASE[phase] ?? PHASE.idle;
    dot.className = 'kv-dot' + (cls ? ' ' + cls : '');
    stateText.textContent = label;

    vChannel.textContent = data?.channel || (data?.running ? '（连接中）' : '—');
    vVoice.textContent = data?.voice || '—';
    vTts.textContent = data?.ttsAt || (data?.tts ? '已就绪' : '未就绪');
    // 回答者要看配置：她本人走 Coopanion 主循环的模型，引擎自己走 apigoto 那个备用大脑
    if ((data?.answerBy || 'persona') === 'persona') {
      vBrain.textContent = `${data?.personaModel || 'Coopanion 主循环'} · 她本人`;
    } else {
      vBrain.textContent = `${data?.model || '—'} · 引擎自己`;
    }

    const err = data?.error || '';
    errBox.style.display = err ? '' : 'none';
    errBox.textContent = err;

    const running = !!data?.running || phase === 'starting';
    btnJoin.disabled = busy || running;
    btnLeave.disabled = busy || !running;

    const logs = data?.logs ?? [];
    logBox.textContent = logs.length ? logs.slice(-30).join('\n') : '（还没有输出）';
    logBox.scrollTop = logBox.scrollHeight;

    for (const [id, b] of tabBtns) b.className = 'kv-tab' + (id === tab ? ' on' : '');
    pageConn.style.display = tab === 'conn' ? '' : 'none';
    pageTest.style.display = tab === 'test' ? '' : 'none';
    // 令牌状态：填过了就不用一直催
    tokenHint.textContent = data?.hasToken
      ? '令牌已设置。想换就再填一次。'
      : '还没填令牌 —— 检测和进频道都会失败。令牌在 KOOK 开发者后台 → 你的应用 → 机器人 → Token。';

    pageEnv.style.display = tab === 'env' ? '' : 'none';
    if (tab === 'env') {
      // 切到这个页签时自动查一次（内部有 10 秒节流）
      void loadEnv();
    }
    renderTree();
  }

  async function refresh() {
    const next = await pull(ctx);
    if (next) {
      data = next;
      render();
    }
  }

  async function act(method, args = []) {
    if (busy) return;
    busy = true;
    render();
    try {
      const out = await ctx.invoke(method, args);
      if (out && typeof out === 'object' && out.message) {
        testMsg.style.display = '';
        testMsg.textContent = (out.ok === false ? '✗ ' : '') + out.message;
      }
    } catch (e) {
      testMsg.style.display = '';
      testMsg.textContent = '✗ ' + (e?.message ?? String(e));
    } finally {
      busy = false;
      await refresh();
    }
  }

  btnJoin.addEventListener('click', () => void act('join'));
  btnLeave.addEventListener('click', () => void act('leave'));
  btnDetect.addEventListener('click', () => void doDetect());
  btnSaveToken.addEventListener('click', () => {
    const t = tokenInput.value.trim();
    if (!t) {
      tip('令牌是空的');
      return;
    }
    btnSaveToken.disabled = true;
    void (async () => {
      try {
        const r = await ctx.invoke('setToken', [t]);
        tip(r?.message || '已保存');
        tokenInput.value = '';
        tokenInput.placeholder = '已保存（要换就再填一次）';
        await refresh();
      } catch (e) {
        tip('保存失败：' + (e?.message ?? String(e)));
      } finally {
        btnSaveToken.disabled = false;
      }
    })();
  });
  btnFetch.addEventListener('click', () => {
    btnFetch.disabled = true;
    btnFetch.textContent = '正在下载…（进度看「连接」页的引擎输出）';
    void (async () => {
      try {
        await act('fetchEnv');
      } finally {
        btnFetch.textContent = '下载依赖（约 225 MB）';
        // 下完/中断后强制刷两次（force 绕过节流），让红叉有机会变绿
        setTimeout(() => void loadEnv(true), 5000);
        setTimeout(() => {
          void loadEnv(true);
          btnFetch.disabled = false;
        }, 20000);
      }
    })();
  });
  btnEnvRefresh.addEventListener('click', () => void refreshEnv());
  pickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnDetect.click();
  });
  btnSay.addEventListener('click', () => {
    const t = input.value.trim();
    if (t) void act('say', [t]);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSay.click();
  });

  void refresh();
  const timer = setInterval(() => void refresh(), 2500);

  return {
    unmount() {
      clearInterval(timer);
    },
  };
}

export default { panels: { kookvoice: { mount } } };
