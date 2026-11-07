// Coo 的桥接主程序：一只耳朵 + 一张嘴 + 一个大脑
//
// 三路输入，一路输出：
//   ① KOOK 文字频道（WebSocket 网关）→ 念出来 / 或交给大脑回一句
//   ② 语音频道里的人声（系统环回采集 → VAD → 本地识别）→ 交给大脑回一句
//   ③ 命令行打字（可选）
// 输出统一是：TTS → 同一条不断开的 RTP 流 → 语音频道
//
// 用法：
//   node bridge.mjs                # 读 bridge.json
//   node bridge.mjs --list         # 列出频道 id
//   node bridge.mjs --ear          # 本次开启耳朵（等价于 bridge.json 里 ear.enabled=true）
//   node bridge.mjs --no-ear       # 本次关闭耳朵
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { api, loadToken } from '../p0/kook.mjs';
import { VoiceStream, waitTts, listVoices, currentVoice, setVoice } from './voice-core.mjs';
import { KookGateway } from './kook-gateway.mjs';

// 注意：这里必须自己算一份 p1 目录，不能复用 kook.mjs 的 HERE（那个指向 p0/）。
// 曾经因为共用 HERE，配置读成了 p0/bridge.json（旧文件、没有 ear 段），耳朵一直不启动。
const P1_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(P1_DIR, 'bridge.json');

// ── 日志落盘 ────────────────────────────────────────────────────
// 控制台那点滚动历史根本不够诊断「她为什么没反应」。
// 每次运行写一份 p1/logs/run-<时间>.log，事后直接翻。
const LOG_DIR = path.join(P1_DIR, 'logs');
const TMP_DIR = path.join(LOG_DIR, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const LOG_PATH = path.join(LOG_DIR, `run-${stamp}.log`);
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
logStream.on('error', () => {});
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    orig(...a);
    try {
      const t = new Date();
      const hh = String(t.getHours()).padStart(2, '0');
      const mm = String(t.getMinutes()).padStart(2, '0');
      const ss = String(t.getSeconds()).padStart(2, '0');
      const ms = String(t.getMilliseconds()).padStart(3, '0');
      logStream.write(`[${hh}:${mm}:${ss}.${ms}] ` + a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n');
    } catch {}
  };
}
console.log(`日志：${LOG_PATH}`);

// 之前进程会在没有任何日志的情况下静默退出（日志停在最后一个正常事件上），
// 那种「莫名其妙就没了」基本都是未捕获异常/未处理的 Promise 拒绝。
// 兜住并写进日志，下次能直接看到堆栈。
process.on('uncaughtException', (e) => {
  try {
    console.log(`✗ 未捕获异常：${e && (e.stack || e.message || e)}`);
  } catch {}
  setTimeout(() => process.exit(1), 300);
});
process.on('unhandledRejection', (e) => {
  try {
    console.log(`✗ 未处理的 Promise 拒绝：${(e && (e.stack || e.message)) || e}`);
  } catch {}
});

const DEFAULT_CONFIG = {
  _comment:
    'voiceChannelId = Coo 说话的语音频道；textChannelIds 留空=只监听语音频道自带的聊天框；ear = 耳朵；brain = 大脑',

  voiceChannelId: '6939628499949215',
  textChannelIds: [],
  onlyMention: false,
  speakSpeakerName: false,
  maxChars: 160,
  interrupt: false,
  // 文字频道消息的处理方式：verbatim=原样念出来，brain=让 Coo 自己回一句
  textReplyMode: 'verbatim',

  ear: {
    enabled: false,
    device: '', // 环回设备名子串；留空 = 采集所有环回并混音（换设备不用改配置）
    probeSeconds: 4,
    replyMode: 'name', // name=被叫到才回，always=每句都回，off=只显示不回
    aliases: ['coo', 'cou', '可可', '扣扣', '小扣', '酷酷'],
    cooldownMs: 4000,
  },

  brain: {
    provider: 'infistar',
    providersRoot: 'F:\\Coopanion\\data\\home\\providers',
    model: 'glm-5.3-flash',
    maxTokens: 160,
    temperature: 0.85,
  },
};

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8');
    console.log(`· 已生成默认配置 ${CONFIG_PATH}`);
    return deepMerge(DEFAULT_CONFIG, {});
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (e) {
    console.error(`✗ bridge.json 解析失败：${e.message}`);
    process.exit(1);
  }
}

// ── 参数 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  const token = loadToken();
  const me = await api('GET', '/user/me', { token });
  const guilds = await api('GET', '/guild/list', { token });
  console.log(`Bot: ${me.username} (id=${me.id})\n`);
  for (const g of guilds.items || []) {
    console.log(`【${g.name}】 guild_id=${g.id}`);
    const list = await api('GET', '/channel/list', { token, query: { guild_id: g.id } });
    for (const c of list.items || []) {
      if (c.type === 1) console.log(`   文字  #${c.name}  ${c.id}`);
      if (c.type === 2) console.log(`   语音  ${c.name}  ${c.id}`);
    }
    console.log();
  }
  process.exit(0);
}

const config = loadConfig();

let textFilter = config.textChannelIds || [];
let voiceChannelId = process.env.COO_CHANNEL_ID || config.voiceChannelId;
let earEnabled = !!config.ear.enabled;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--text') textFilter = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--mention-only') config.onlyMention = true;
  else if (a === '--speaker') config.speakSpeakerName = true;
  else if (a === '--ear') earEnabled = true;
  else if (a === '--no-ear') earEnabled = false;
  else if (a === '--device') config.ear.device = argv[++i] || '';
  else if (!a.startsWith('--')) voiceChannelId = a;
}
if (!voiceChannelId) {
  console.error('用法：node bridge.mjs [语音频道id] [--ear|--no-ear] [--device 设备名] [--text 文字频道id] [--mention-only] [--speaker] [--list]');
  process.exit(1);
}

// ── 文本处理 ───────────────────────────────────────────────────
/** KMarkdown → 适合朗读的纯文本 */
function cleanKMarkdown(s) {
  return String(s || '')
    .replace(/\(met\)[^()]*?\(met\)/g, '')
    .replace(/\(chn\)[^()]*?\(chn\)/g, '')
    .replace(/\(role\)[^()]*?\(role\)/g, '')
    .replace(/\(spl\)([\s\S]*?)\(spl\)/g, '$1')
    .replace(/\(emj\)[^()]*?\(emj\)\[([^\]]*)\]/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clamp(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('，'));
  return (at > max * 0.5 ? cut.slice(0, at + 1) : cut) + '……后面不念了';
}

/** 判断两句话像不像（防回声的兜底） */
function similar(a, b) {
  if (!a || !b) return false;
  const setA = new Set(a.replace(/[\s，。！？、,.!?]/g, ''));
  const setB = new Set(b.replace(/[\s，。！？、,.!?]/g, ''));
  if (!setA.size || !setB.size) return false;
  let hit = 0;
  for (const ch of setA) if (setB.has(ch)) hit++;
  return hit / Math.min(setA.size, setB.size) >= 0.75;
}

// ── 启动语音 ───────────────────────────────────────────────────
{
  const token = loadToken();
  try {
    const busy = await api('GET', '/voice/list', { token });
    const items = busy.items || [];
    if (items.length) {
      console.log(`! 检测到已占用 ${items.length} 个语音频道（可能是上一次的窗口还开着），先强制释放`);
      for (const c of items) {
        try {
          await api('POST', '/voice/leave', { token, body: { channel_id: c.id } });
          console.log(`  · 已离开 ${c.name || c.id}`);
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch {}
}

const vs = new VoiceStream(voiceChannelId, { password: process.env.KOOK_VOICE_PASSWORD });

console.log('[1/5] 加入语音频道 …');
const info = await vs.join();
console.log(`✓ 已加入，码率上限 ${info.bitrate} bps`);

console.log('[2/5] 启动常驻流 …');
const { kbps } = vs.start();
console.log(`✓ 常驻流已启动（${kbps}k opus / 48kHz）`);

// 嗓子和耳朵是两条独立的链路：嗓子挂了还能听，只是不出声。
// 这里把「没起来」说清楚，而不是等到说话时才甩一个 fetch failed。
console.log('[3/5] 等嗓子就绪 …');
const ttsOk = await waitTts(120000, (s) => console.log(s));
if (!ttsOk) {
  console.log('! 嗓子没起来：她现在能听、能想，但说不出话。');
  console.log('  双击 p1\\start-tts.bat 起 GPT-SoVITS（冷启动 30–60 秒），然后重开本程序。');
} else {
  const warm = await vs.warmup();
  console.log(warm < 0 ? '! 预热失败（推理服务报错，看 start-tts 那个窗口）' : `✓ 模型已就绪（${warm}ms）`);
}

// ── 本地监听：她说的话同时从本机扬声器出来 ──────────────────────
// KOOK 不会把推上去的音频再回放给你。一个人测试时，日志里明明打了
// `Coo: 是啊`，耳朵里却一片安静，很容易误判成「她没反应」。
// 这条路让单人也能形成闭环。bridge.json 里 ear.monitor=false 可关。
let monitorProc = null;
if (!config.ear || config.ear.monitor !== false) {
  const mScript = path.join(P1_DIR, '..', 'p2', 'monitor.py');
  if (!fs.existsSync(mScript)) {
    console.log('· 没找到 p2/monitor.py，跳过本地监听');
  } else {
    try {
      monitorProc = spawn(findPython(), [mScript, (config.ear && config.ear.monitorDevice) || ''], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      });
      monitorProc.stdin.on('error', () => {});
      monitorProc.on('error', () => {});
      monitorProc.stderr.on('data', (d) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) {
          const s = line.trim().replace(/^·\s*/, '');
          if (s) console.log(`[监听] ${s}`);
        }
      });
      let seq = 0;
      vs.monitor = (wav) => {
        const f = path.join(TMP_DIR, `mon-${process.pid}-${++seq}.wav`);
        try {
          fs.writeFileSync(f, wav);
          if (monitorProc && monitorProc.stdin.writable) monitorProc.stdin.write(`play ${f}\n`);
        } catch {}
      };
      if (config.ear && config.ear.monitorVolume != null) {
        monitorProc.stdin.write(`vol ${config.ear.monitorVolume}\n`);
      }
      console.log('· 本地监听已开：她说话时会同时从本机扬声器出来');
    } catch (e) {
      console.log(`· 本地监听起不来：${e.message}`);
      monitorProc = null;
    }
  }
}

// 查频道名
let selfId = null;
const nameOf = new Map();
const textLikeIds = new Set();
try {
  const me = await api('GET', '/user/me', { token: vs.token });
  selfId = me.id;
  const ch = await api('GET', '/channel/view', { token: vs.token, query: { target_id: voiceChannelId } });
  const list = await api('GET', '/channel/list', { token: vs.token, query: { guild_id: ch.guild_id } });
  for (const c of list.items || []) {
    nameOf.set(c.id, c.name);
    if (c.type === 1) textLikeIds.add(c.id);
  }
  console.log(`✓ 语音频道「${nameOf.get(voiceChannelId) || '?'}」`);
} catch (e) {
  console.error(`! 查询频道信息失败（不影响功能）：${e.message}`);
}

if (textFilter.length) {
  console.log(`· 文字触发频道：${textFilter.map((id) => '#' + (nameOf.get(id) || id)).join(' ')}`);
} else if (voiceChannelId) {
  // 默认只认「语音频道自带的那个聊天框」。
  // 外面的同名文字频道是另一个 id，用户在别处打字不该惊动她。
  // 想多听几个频道就把 id 填进 bridge.json 的 textChannelIds。
  textFilter = [voiceChannelId];
  console.log('· 只监听语音频道自带的聊天框（外部文字频道不响应）');
} else {
  console.log('! 既没配语音频道也没配 textChannelIds，文字触发关闭（语音触发不受影响）');
}

// ── 大脑 ───────────────────────────────────────────────────────
// persona 模式下由 Coopanion 主循环来回答，这个备用大脑根本不会被调用。
// 那就不初始化：省一份连接，也免得日志里出现「大脑就绪」让人以为它在干活。
const ANSWER_BY = process.env.COO_ANSWER_BY || 'self';
let brain = null;
if (ANSWER_BY === 'persona') {
  console.log('· 回答交给 Coopanion 主循环（本进程只听话、不思考）');
} else {
  try {
    // 按需加载：persona 模式下 brain.mjs 没必要进内存（它要读 providers 目录）
    const { Brain } = await import('../p2/brain.mjs');
    brain = new Brain(config.brain);
    console.log(`✓ 大脑就绪（${config.brain.provider} / ${brain.model}）`);
  } catch (e) {
    console.error(`! 大脑初始化失败：${e.message}（会退化成「原样复读」模式）`);
  }
}

// ── 耳朵 ───────────────────────────────────────────────────────
function findPython() {
  const base = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'binaries', 'python', 'versions');
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'python.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return 'python';
}

class Ear {
  constructor({ device, mic, probeSeconds, onText, log }) {
    this.device = device;
    this.mic = mic;
    this.probeSeconds = probeSeconds || 4;
    this.onText = onText;
    this.log = log;
    this.proc = null;
    this.muted = false;
    this.ready = false;
    this._probeStart = null;
    this._probeWaiters = [];
  }

  /** 等耳朵开口说「我开始探测了」，最多等 ms 毫秒（它要先把模型加载完） */
  waitProbe(ms = 12000) {
    if (this._probeStart) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      this._probeWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  start() {
    const py = findPython();
    const script = path.join(P1_DIR, '..', 'p2', 'ear.py');
    if (!fs.existsSync(script)) throw new Error(`找不到 ${script}`);
    const args = [script];
    if (this.device) args.push('--device', this.device);
    if (this.mic) args.push('--mic', this.mic);
    else args.push('--probe', String(this.probeSeconds));

    this.proc = spawn(py, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });

    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'probe-start') {
          this._probeStart = true;
          const ws = this._probeWaiters.splice(0);
          for (const fn of ws) fn();
        } else if (msg.type === 'ready') {
          this.ready = true;
          this.log('✓ 耳朵已就绪，正在听');
        } else if (msg.type === 'device') {
          this.log(`· 采集设备：${msg.name}`);
        } else if (msg.type === 'text') {
          this.onText(msg);
        } else if (msg.type === 'error') {
          this.log(`✗ 耳朵报错：${msg.message}`);
        }
      }
    });

    this.proc.stderr.on('data', (d) => {
      // soundcard 在设备切换/缓冲抖动时会刷这条警告，无害但会淹掉有用信息
      const NOISE = /SoundcardRuntimeWarning|warnings\.warn|data discontinuity/i;
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (s && !NOISE.test(s)) this.log(`  [ear] ${s}`);
      }
    });

    this.proc.on('exit', (code) => {
      if (code !== 0 && code !== null) this.log(`✗ 耳朵进程退出 code=${code}`);
      this.ready = false;
    });
    // 进程被杀后再写 stdin 会抛 EPIPE，不吞掉就成了未捕获异常
    this.proc.on('error', () => {});
    this.proc.stdin.on('error', () => {});
    this.proc.stdout.on('error', () => {});
    this.proc.stderr.on('error', () => {});
  }

  send(cmd) {
    try {
      if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(cmd + '\n');
    } catch {}
  }

  mute() {
    if (this.muted) return;
    this.muted = true;
    this.send('mute');
  }

  unmute() {
    if (!this.muted) return;
    this.muted = false;
    this.send('unmute');
  }

  stop() {
    this.send('quit');
    try {
      this.proc && this.proc.kill();
    } catch {}
  }
}

// 半双工：她说话时关掉耳朵，说完再开。
// 这是「防听见自己」的正解——靠时序，不靠调音量。
let generating = false;
let lastActiveAt = 0;
let reconnecting = false; // 掉线重连的防重入
let lastReplyAt = 0;
const recentSpoken = [];

// 音乐/噪音常被识别成这些，直接丢
const JUNK = /^(谢谢观看|谢谢大家|字幕|请不吝|点赞|订阅|关注|www\.|http)/i;

if (earEnabled) {
  console.log('[4/5] 启动耳朵 …');
  var ear = new Ear({
    device: config.ear.device,
    mic: config.ear.mic,
    probeSeconds: config.ear.probeSeconds,
    log: (s) => console.log(s),
    onText: (msg) => handleUtterance(msg),
  });
  ear.start();

  // 启动时说一句，既打招呼，也给「自动选设备」提供信号：
  // 这句会从 KOOK 播放出来，耳朵在探测窗口里就能认出哪个设备才是 KOOK 的输出
  if (!config.ear.device) {
    console.log('· 等耳朵准备好，然后说一句招呼语，让它确认 KOOK 的声音从哪个设备出来 …');
    const ok = await ear.waitProbe(12000);
    if (!ok) console.log('  （没等到耳朵的探测信号，仍然说话，可能选错设备）');
    try {
      const greeting = '我来了，能听见我吗？';
      recentSpoken.push(greeting);
      await vs.speak(greeting);
    } catch (e) {
      console.error(`! 招呼语合成失败：${e.message}`);
    }
  }

  setInterval(() => {
    // 掉线重连：keep-alive 连续失败三次 → vs.lost。
    // 不重连的话，KOOK 那边已经把她踢了，我们还在往一个死地址推流，
    // 面板却一直显示「在听」——今天就是这么「后面全哑」的。
    if (vs.lost && !reconnecting) {
      reconnecting = true;
      console.error('! 掉出频道了，正在重连…');
      void (async () => {
        try {
          await vs.leave();
          const info = await vs.join();
          vs.lost = false;
          vs.keepAliveFails = 0;
          console.log(`✓ 已重连（${info.kbps}kbps）`);
          ear.unmute();
          reconnecting = false;
        } catch (e) {
          console.error(`! 重连失败：${e?.message ?? e}（10 秒后再试）`);
          setTimeout(() => {
            reconnecting = false;
          }, 10000);
        }
      })();
    }

    const active = generating || vs.queue.pendingMs > 0;
    if (active) {
      lastActiveAt = Date.now();
      ear.mute();
    } else if (ear.muted && Date.now() - lastActiveAt > 1200) {
      ear.unmute();
    }
  }, 250);
} else {
  console.log('[4/5] 耳朵关闭（bridge.json 里 ear.enabled=false，或本次加了 --no-ear）');
}

// ── 语音输入 → 大脑 → 说话 ──────────────────────────────────────
async function handleUtterance(msg) {
  const text = String(msg.text || '').trim();
  if (!text || text.length < 2) return;
  if (JUNK.test(text)) return;

  // 回声兜底：和她刚说的话高度相似就丢掉（半双工之外的第二道保险）
  // 只在够长的句子上比对：像「我。」这种两字碎片，字符集必然被她说过的话包含，
  // 会被误判成回声而丢掉（真实对话里「我在」「好吧」就会中招）
  if (text.length >= 6 && recentSpoken.some((s) => similar(s, text))) {
    console.log(`[耳朵] (回声，忽略) ${text}`);
    return;
  }

  console.log(`[耳朵] ${text}  （音频 ${msg.dur}s，识别 ${msg.cost}s，峰值 ${msg.peak ?? '-'}）`);

  const mode = process.env.COO_REPLY_MODE || config.ear.replyMode || 'name';
  if (mode === 'off') return;
  if (mode === 'name') {
    // 唤醒词：插件会按桌宠自己的名字传进来（COO_ALIASES），没传就用 bridge.json 里的。
    // 分隔符支持逗号、中文逗号、顿号、空格，用户怎么填都行。
    const aliasList = process.env.COO_ALIASES
      ? process.env.COO_ALIASES.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean)
      : (config.ear.aliases || []);
    const low = text.toLowerCase();
    const called = aliasList.some((a) => low.includes(String(a).toLowerCase()));
    if (!called) {
      console.log(`  (没叫她的名字，不回；唤醒词：${aliasList.join('/') || '未设置'})`);
      return;
    }
  }

  // 交给 Coopanion 主循环去回（她本人，带记忆和上下文）。
  // 这里只打一行机器可读的标记，插件读到就 pushEvent；引擎自己不再调模型。
  if (process.env.COO_ANSWER_BY === 'persona') {
    // 冷却也要管住这条路 —— 原来它放在下面 self 分支里，persona 直接 return 就绕过了。
    // VAD 把一句话切成两段时，会连着投两次，她就回两遍（听起来像复读）。
    const cool = config.ear.cooldownMs || 4000;
    if (Date.now() - lastReplyAt < cool) {
      console.log(`  (刚投过，冷却中 ${Math.round((cool - (Date.now() - lastReplyAt)) / 1000)}s)`);
      return;
    }
    lastReplyAt = Date.now();
    console.log(`[投递] ${JSON.stringify({ text, dur: msg.dur, peak: msg.peak ?? 0 })}`);
    return;
  }

  if (!brain) {
    console.log('  (没有大脑，只能记下来)');
    return;
  }
  if (Date.now() - lastReplyAt < (config.ear.cooldownMs || 4000)) {
    console.log('  (冷却中，先不接话)');
    return;
  }
  lastReplyAt = Date.now();

  generating = true;
  try {
    const t0 = Date.now();
    let first = true;
    for await (const sentence of brain.streamReply(text)) {
      if (first) {
        console.log(`  → 首句 ${Date.now() - t0}ms`);
        first = false;
      }
      recentSpoken.push(sentence);
      if (recentSpoken.length > 6) recentSpoken.shift();
      console.log(`  Coo: ${sentence}`);
      await vs.speak(sentence);
    }
  } catch (e) {
    console.error(`✗ 回答失败：${e.message}`);
  } finally {
    generating = false;
  }
}

// ── 文字频道 → 说话 ─────────────────────────────────────────────
const seen = new Set();
function once(id) {
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 300) seen.delete(seen.values().next().value);
  return true;
}

async function sayFromText(text) {
  if (config.textReplyMode === 'brain' && brain) {
    generating = true;
    try {
      for await (const sentence of brain.streamReply(text)) {
        recentSpoken.push(sentence);
        if (recentSpoken.length > 6) recentSpoken.shift();
        console.log(`  Coo: ${sentence}`);
        await vs.speak(sentence);
      }
    } catch (e) {
      console.error(`✗ 回答失败：${e.message}`);
    } finally {
      generating = false;
    }
  } else {
    await vs.speak(text);
  }
}

const gw = new KookGateway({
  onEvent: async (d) => {
    // 排查用：先看网关到底推了什么过来，再判断是哪一步把它挡掉的
    if (process.env.COO_TRACE_EVENTS) {
      console.log(`[evt] type=${d.type} ct=${d.channel_type || '-'} target=${d.target_id || '-'}`);
    }
    if (![1, 9, 10].includes(d.type)) return;
    if (!['GROUP', 'PERSON'].includes(d.channel_type)) return;

    const author = d.extra?.author || {};
    // 调试开关：COO_ALLOW_SELF=1 时不忽略机器人自己发的消息，用来验证链路
    const allowSelf = !!process.env.COO_ALLOW_SELF;
    if (author.bot && !allowSelf) return;
    if (selfId && author.id === selfId && !allowSelf) return;
    if (!once(d.id || d.msg_id)) return;

    const isDM = d.channel_type === 'PERSON';
    if (!isDM && textFilter.length && !textFilter.includes(d.target_id)) {
      console.log(`  (频道 ${d.target_id} 不在监听的列表里，要加就填进 bridge.json 的 textChannelIds)`);
      return;
    }

    const mentionMe = selfId && d.extra?.mention?.includes(selfId);
    if (config.onlyMention && !mentionMe && !isDM) return;

    let text = cleanKMarkdown(d.content);
    if (!text) return;
    text = clamp(text, config.maxChars);

    const who = author.username || author.id || '某人';
    const where = isDM ? '私聊' : '#' + (nameOf.get(d.target_id) || d.target_id);

    try {
      console.log(`[${where}] ${who}: ${text}`);
      await sayFromText(config.speakSpeakerName && !isDM ? `${who}说，${text}` : text);
      console.log(`   → 队列余 ${(vs.queue.pendingMs / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`✗ 合成失败：${e.message}`);
    }
  },
  log: (s) => console.log(s),
});

console.log(`· 配置：${CONFIG_PATH}（耳朵 ${earEnabled ? '开' : '关'}）`);
console.log('[5/5] 连接 KOOK 网关 …');
await gw.start();
const replyMode = process.env.COO_REPLY_MODE || (config.ear && config.ear.replyMode) || 'name';
console.log(
  `\n就绪。${earEnabled ? `耳朵已开（${replyMode === 'always' ? '说什么都接' : replyMode === 'name' ? '叫名字才接' : '只听不回'}），` : ''}文字频道打字她也会念。Ctrl+C 退出。\n`,
);
if (earEnabled) {
  console.log('  两条提醒：');
  if (replyMode === 'always') {
    console.log('   1) 直接说话就行，不用叫名字；她说话时会关掉耳朵，等她说完了你再说。');
  } else {
    console.log('   1) 先叫她的名字，例如「Coo，在吗」「可可，帮我想想」；');
    console.log('   2) 她说话时耳朵是关着的（防听见自己），要等她说完再说。');
  }
  if (config.ear && config.ear.monitor !== false) {
    console.log('  本地监听已开：她的话会从本机扬声器再放一遍（仅调试用，会和 KOOK 播放叠成回声）。\n');
  } else {
    console.log('  她的话由你的 KOOK 客户端直接播放（她在频道里，就像队友一样）。\n');
  }
}

// ── 窗口里的小命令 ──────────────────────────────────────────────
// 换音色不该逼人改 json 再重启。直接在跑着的窗口里敲 /voice 就行。
const cv = currentVoice();
console.log(`  当前音色：${cv ? `${cv.name}（${cv.id}）` : '未配置'}`);
console.log('  窗口命令：/voice 看音色  /voice <id> 换  /say <文本> 让她说一句  /quit 退出\n');

// 插件是拿管道接进来的（不是 TTY），但那也要能收 /say、/voice 这些命令 ——
// 面板上的「试听」就是往这里写一行 /say。所以只判断 stdin 存不存在。
if (process.stdin) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    if (s === '/voice' || s === '/voices') {
      const cur = currentVoice();
      console.log(`\n当前音色：${cur ? `${cur.name}（${cur.id}）` : '未配置'}`);
      for (const v of listVoices()) {
        console.log(` ${v.active ? '▶' : ' '} ${v.id.padEnd(10)} ${v.name.padEnd(12, '　')} ${v.note || ''}`);
      }
      console.log('  切换：/voice <id>\n');
      return;
    }
    if (s.startsWith('/voice ')) {
      const id = s.slice(7).trim();
      const v = setVoice(id);
      if (!v) {
        console.log(`✗ 没有这个音色：${id}（可用：${listVoices().map((x) => x.id).join(' / ')}）`);
        return;
      }
      console.log(`✓ 已切到「${v.name}」，下一句立即生效`);
      return;
    }
    if (s.startsWith('/say ')) {
      const t = s.slice(5).trim();
      if (!t) return;
      try {
        // 打出实际要念的文本，排查「声音怪」时第一眼看这个：
        // 带 markdown、引号、英文、过长，都会让 TTS 念得不对。
        console.log(`/say ${JSON.stringify(t)}`);
        const r = await vs.speak(t);
        console.log(`✓ 已入队 ${r.pcmMs}ms`);
      } catch (e) {
        console.error(`✗ ${e.message}`);
      }
      return;
    }
    if (s === '/quit' || s === '/exit') {
      await shutdown();
      return;
    }
    console.log('命令：/voice 看音色 · /voice <id> 换 · /say <文本> 说一句 · /quit 退出');
  });
}


let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n清理中…');
  // 硬兜底：不管下面哪一步卡住，6 秒后一定退出（否则关窗口后还占着语音频道）
  const hard = setTimeout(() => process.exit(0), 6000);
  hard.unref?.();

  const guard = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

  // 先退语音频道——这一步最要紧，不退会一直占着连接，下次启动得强制释放
  try {
    await guard(vs.leave(), 3000);
  } catch {}
  try {
    if (typeof ear !== 'undefined' && ear) ear.stop();
  } catch {}
  try {
    if (monitorProc) {
      monitorProc.stdin.write('quit\n');
      monitorProc.kill();
    }
  } catch {}
  try {
    await guard(gw.stop(), 2000);
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
