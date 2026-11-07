/**
 * KOOK 语音世界。
 *
 * 这里不重造引擎 —— 真正干活的是工作区里那套独立程序：
 *   p1/bridge.mjs   说话（KOOK 推流 + TTS）
 *   p2/ear.py       听话（环回+麦克风 → VAD → 本地识别）
 * 本文件只做三件事：把进程拉起来、读它的输出更新状态、按命令停掉。
 *
 * 这样改引擎不用动插件，排查问题也还是看那一条日志线。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = 'kookvoice';
const PANEL_ID = 'kookvoice';
const LOG_KEEP = 200;
const DEFAULT_DIR = 'F:/AI/WorkBuddy-workspace/建议Kook桌宠对话插件';
const DEFAULT_GSV = 'F:/GPT-SOVITS-v5';
const DEFAULT_TTS_CFG = 'F:/Coopanion/data/home/companion/data/gpt-sovits/tts_infer.cuda.yaml';
const TTS_PORT = 9881; // 自己拉的那份
const PLUGIN_TTS_PORT = 9880; // Coopanion 的 GPTSoVits 插件

// 工具定义只写一份在 describe.json 里，这里补 handler。
const TOOL_SPECS = JSON.parse(
  fs.readFileSync(new URL('../describe.json', import.meta.url), 'utf8'),
).tools;

/** 找 node：优先环境变量，其次 WorkBuddy 自带的，最后退回 PATH。 */
/**
 * 找一个能跑 bridge.mjs 的 Node。
 *
 * 优先级：
 *   1. COO_NODE 环境变量（手动指定）
 *   2. **Coopanion 自己的 Electron**（ELECTRON_RUN_AS_NODE=1，实测 v24，最可靠 ——
 *      别的用户不会有 WorkBuddy，也就没有那个 node 目录）
 *   3. WorkBuddy 自带的 node（开发机）
 *   4. PATH 里的 node
 *
 * 返回 { cmd, extraEnv }：Electron 那条要额外带一个环境变量。
 */
function findNode() {
  const env = process.env.COO_NODE;
  if (env && fs.existsSync(env)) return { cmd: env, extraEnv: {} };

  // 插件跑在 Coopanion 里，process.execPath 就是 Coopanion.exe
  if (process.versions.electron && process.execPath && fs.existsSync(process.execPath)) {
    return { cmd: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  try {
    const dirs = fs.readdirSync(base).sort().reverse();
    for (const d of dirs) {
      const p = path.join(base, d, 'node.exe');
      if (fs.existsSync(p)) return { cmd: p, extraEnv: {} };
    }
  } catch {}
  return { cmd: 'node', extraEnv: {} };
}

/** 端口通不通 —— TTS 冷启动要几十秒，只能轮询等。 */
function portOpen(port, timeout = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class KookVoiceWorld {
  constructor(ctx) {
    // 框架按 id 归属工具与事件，必须和定义的 id 一致，否则挂载时判失败。
    this.id = ID;
    this.ctx = ctx;
    this.host = null;
    this.proc = null;
    this.timer = null;
    this.spawnedCfg = null;
    this.restarting = false;
    this.leaving = false;
    this.fetching = false;
    this.logs = [];
    this.starting = false;
    // 面板填的令牌直接塞进环境，这样引擎和 detect() 都能读到，
    // 用户也不用去找 engine/p0/token.txt
    const _tk = String(this.cfg('kookToken', '')).trim();
    if (_tk) process.env.KOOK_TOKEN = _tk;
    /** 注意：不能叫 state —— 下面有同名方法要给面板调 */
    this.snap = {
      running: false,
      phase: 'idle', // idle | starting | listening | error
      channel: '',
      voice: '',
      model: '',
      tts: false,
      ttsAt: '',
      error: '',
      since: 0,
    };
  }

  cfg(key, fallback) {
    const v = this.ctx?.cfg?.[key];
    return v === undefined || v === null ? fallback : v;
  }

  get engineDir() {
    return String(this.cfg('engineDir', DEFAULT_DIR)).replace(/[\\/]+$/, '');
  }

  /**
   * ffmpeg 实际在哪：下载到用户数据目录的优先，否则用引擎自带的。
   * 传不存在的路径也没关系（引擎那边会跳过继续找），但传对的能省一次探测。
   */
  get ffmpegPath() {
    const dl = this.dataDir ? path.join(this.dataDir, 'kookvoice', 'bin', 'ffmpeg.exe') : '';
    if (dl && fs.existsSync(dl)) return dl;
    return path.join(this.engineDir, 'p0', 'bin', 'ffmpeg.exe');
  }

  /**
   * 用户数据目录（框架给每个世界分配，onepiece 也是这么拿的）。
   * 模型和 ffmpeg 下到这里而不是插件包里 —— 重装/升级插件不会把 230 MB 弄丢。
   */
  get dataDir() {
    return String(this.ctx?.dataDir || '').trim();
  }

  // ── 生命周期 ────────────────────────────────────────────────
  async start(host) {
    this.host = host;
    // 框架不会替你调 tick()，得自己起定时器（onepiece 也是这么干的）。
    // 5 秒一次：既够快让改配置后马上重启引擎，又不至于白耗 CPU。
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref?.();
    // 进频道只有一个入口：人在面板上点「检测」选好频道，再点「进频道」。
    // 没有 autoStart 这种东西 —— 重启 Coopanion 不该让桌宠自己跳进公开语音里。
    this.pushLog('· 待命（面板上选好频道、点「进频道」才会开始）');
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.leave();
    this.host = null;
  }

  /**
   * 检测：把一个服务器标识解析出来，顺便把语音频道按分组列成树。
   *
   * 服务器标识三种写法都认：
   *   19 位雪花 id（2242002608388422）—— 接口用的
   *   8 位短号（17023898）—— 客户端界面上显示的那个，对应 open_id
   *   服务器名字（穹的聊天室）
   * 不填的话：机器人只在一台服务器里就自动用它。
   */
  async detect(query) {
    const entry = path.join(this.engineDir, 'p0', 'kook.mjs');
    if (!fs.existsSync(entry)) {
      return { ok: false, error: `找不到引擎里的 KOOK 模块：${entry}` };
    }
    let mod;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (e) {
      return { ok: false, error: `加载 KOOK 模块失败：${e?.message ?? e}` };
    }

    let token;
    try {
      token = mod.loadToken();
    } catch (e) {
      return { ok: false, error: `没读到 KOOK 令牌：${e?.message ?? e}` };
    }

    // ① 找服务器
    let guilds = [];
    try {
      const gl = await mod.api('GET', '/guild/list', { token, query: { page: 1, page_size: 50 } });
      guilds = gl.items || [];
    } catch (e) {
      return { ok: false, error: `拉服务器列表失败：${e?.message ?? e}` };
    }
    if (!guilds.length) return { ok: false, error: '机器人还没加入任何服务器' };

    const q = String(query || '').trim();
    let guild = null;
    if (q) {
      guild =
        guilds.find((g) => String(g.id) === q || String(g.open_id) === q) ||
        guilds.find((g) => String(g.name) === q) ||
        guilds.find((g) => String(g.name).includes(q));
    } else if (guilds.length === 1) {
      guild = guilds[0];
    }
    if (!guild) {
      return {
        ok: false,
        error: q ? `没找到「${q}」这台服务器` : '机器人加入了多台服务器，请指定一个',
        guilds: guilds.map((g) => ({ id: String(g.id), openId: String(g.open_id || ''), name: g.name })),
      };
    }

    // ② 列频道，按 parent_id 组成「分组 → 子频道」
    let items = [];
    try {
      const cl = await mod.api('GET', '/channel/list', { token, query: { guild_id: guild.id } });
      items = cl.items || [];
    } catch (e) {
      return { ok: false, error: `拉频道列表失败：${e?.message ?? e}` };
    }

    const cats = items.filter((c) => c.type === 0);
    const voices = items.filter((c) => c.type === 2);
    const groups = [];
    for (const c of cats) {
      const children = voices.filter((v) => v.parent_id === c.id).map((v) => ({ id: String(v.id), name: v.name }));
      if (children.length) groups.push({ id: String(c.id), name: c.name, children });
    }
    const known = new Set(cats.map((c) => c.id));
    const orphans = voices.filter((v) => !v.parent_id || !known.has(v.parent_id));
    if (orphans.length) {
      groups.push({ id: '', name: '未分组', children: orphans.map((v) => ({ id: String(v.id), name: v.name })) });
    }

    this.pushLog(`· 检测到「${guild.name}」：${voices.length} 个语音频道，${groups.length} 个分组`);
    return {
      ok: true,
      guild: { id: String(guild.id), openId: String(guild.open_id || ''), name: guild.name },
      groups,
      current: String(this.cfg('channelId', '')),
    };
  }

  /** 面板上选中某个频道后写回配置（问的就是「点进频道之前先选好」） */
  pickChannel(channelId, guildId) {
    const id = String(channelId || '').trim();
    if (!id) return { ok: false, message: '没选频道' };
    const patch = { channelId: id };
    if (guildId) patch.guildId = String(guildId);
    try {
      this.ctx?.persist?.(patch);
    } catch (e) {
      return { ok: false, message: `写配置失败：${e?.message ?? e}` };
    }
    this.snap.channel = '';
    this.pushLog(`· 已选频道：${id}`);
    return { ok: true, message: '选好了，点「进频道」开始' };
  }

  /** 顺手把 KOOK 的语音频道列出来，免得让人手抄一串数字。 */
  async loadChannels() {
    try {
      const entry = path.join(this.engineDir, 'p0', 'kook.mjs');
      if (!fs.existsSync(entry)) return;
      const mod = await import(pathToFileURL(entry).href);
      const token = mod.loadToken();
      const guild = String(this.cfg('guildId', '')).trim();
      const r = await mod.api('GET', '/channel/list', {
        token,
        query: guild ? { guild_id: guild } : {},
      });
      const list = (r.items || [])
        .filter((c) => c.type === 2) // 2 = 语音频道
        .map((c) => ({ value: String(c.id), label: c.name }));
      if (list.length) {
        this.pushLog(`· 语音频道：${list.map((i) => i.label).join(' / ')}`);
      }
    } catch (e) {
      this.pushLog(`! 拉频道列表失败：${e?.message ?? e}`);
    }
  }

  /** 每 5 秒看一眼：配置改过没有、进程还在不在。 */
  async tick() {
    if (this.restarting) return; // 上一次重启还没做完，别再叠一次
    if (this.proc && this.spawnedCfg) {
      // 这些值都是 spawn 时通过环境变量/参数写死给引擎的，改了必须重启才生效。
      // 不这么做的话，人在配置页点了「说什么都接」，引擎那边还在按「叫名字才接」跑，
      // 表现为「明明改了，她还是不理我」。
      const now = {
        replyMode: String(this.cfg('replyMode', 'always')),
        wakeWords: this.wakeOf(),
        voiceId: String(this.cfg('voiceId', '')),
        channelId: String(this.cfg('channelId', '')).trim(),
        ttsSource: String(this.cfg('ttsSource', 'plugin')),
        answerBy: String(this.cfg('answerBy', 'persona')),
        ears: !!this.cfg('ears', true),
      };
      const changed = Object.keys(now).find((k) => now[k] !== this.spawnedCfg[k]);
      if (changed) {
        this.restarting = true;
        this.spawnedCfg = null;
        try {
          this.pushLog(`· 配置变了（${changed}），重启引擎让它生效`);
          await this.leave();
          await this.join();
        } catch (e) {
          this.pushLog(`! 重启引擎失败：${e?.message ?? e}`);
        } finally {
          this.restarting = false;
        }
        return;
      }
    }

    if (!this.proc) return;
    if (this.proc.exitCode !== null || this.proc.killed) {
      const code = this.proc.exitCode;
      this.proc = null;
      this.spawnedCfg = null;
      if (this.snap.running) {
        this.snap.running = false;
        this.snap.phase = 'error';
        this.snap.error = code === 0 ? '已退出' : `引擎进程退出（code=${code}）`;
        this.host?.log?.warn?.(`kookvoice: ${this.snap.error}`);
      }
    }
  }

  // ── 给模型的三只手（必需：没有 handler 挂载会直接判失败）──────────
  tools() {
    return TOOL_SPECS.map((spec) => {
      if (spec.name === 'kook_voice_status') {
        return { ...spec, handler: async () => this.statusText() };
      }
      if (spec.name === 'kook_voice_join') {
        return { ...spec, handler: async () => (await this.join()).message };
      }
      if (spec.name === 'kook_speak') {
        return { ...spec, handler: async (args = {}) => (await this.say(args.text)).message };
      }
      return { ...spec, handler: async () => (await this.leave()).message };
    });
  }

  /** 拼进系统提示词的一小段：她现在在不在频道里。 */
  envPromptVars() {
    const s = this.snap;
    return {
      'kookvoice.state': s.running
        ? `在「${s.channel || '?'}」语音频道里听着`
        : s.error
          ? `语音链路出错了：${s.error}`
          : '不在语音频道里',
      'kookvoice.voice': s.voice || '未知',
    };
  }

  /** 面板声明。ctx.invoke 最终落到下面的 invoke 上，不是实例方法名。 */
  webUi() {
    const s = this.snap;

    const hint =
      s.phase === 'starting'
        ? '正在进频道'
        : s.phase === 'error'
          ? s.error || '出错了'
          : s.running
            ? `在听 · ${s.channel || ''}`
            : '未连接';

    return {
      label: 'KOOK 语音',
      lamps: [{ label: '语音', state: s.running ? 'online' : 'offline', hint }],
      badges: [
        { label: '频道', value: s.channel || '—' },
        { label: '音色', value: s.voice || '—' },
        { label: '大脑', value: s.model || '—' },
      ],
      panels: [
        {
          id: PANEL_ID,
          title: 'KOOK 语音',
          description: '连接状态、当前频道与音色，以及引擎最近二十几行输出。',
          getMethods: ['state'],
        },
      ],
      config: [
        {
          id: 'kookvoice-conn',
          owner: `world:${ID}`,
          title: '连接',
          description: '进哪个频道、用谁的声音、什么时候接话。改完重连一次生效。',
          schema: {
            type: 'object',
            properties: {
              'worlds.kookvoice.answerBy': {
                type: 'string',
                title: '谁来回答',
                description:
                  '「她本人」带记忆和上下文，语音里说的话也算她说过；「引擎自己」更快，但那是另一次对话，她不会记得',
                'x-options': 'answerBy',
              },
              'worlds.kookvoice.replyMode': {
                type: 'string',
                title: '什么时候接话',
                // 中文标签由 index.js 的 configOptions('replyMode') 提供。
                // 框架不认 enumNames，也不认 oneOf —— 只认 x-options 这个自家扩展。
                'x-options': 'replyMode',
              },
              'worlds.kookvoice.wakeWords': {
                type: 'string',
                title: '唤醒词',
                description:
                  '只在「叫名字才接」时生效。多个用逗号隔开；留空就用她在 Coopanion 里的名字。名字长的一定在这里填简称，否则喊简称不会触发',
              },
              'worlds.kookvoice.ttsSource': {
                type: 'string',
                title: '嗓子从哪来',
                description: '用本机已有那份就不必再单独占显存，音色也跟着那个服务走',
                'x-options': 'ttsSource',
              },
              'worlds.kookvoice.ttsUrl': {
                type: 'string',
                title: '语音服务地址',
                description: '只在「复用本机已有的语音服务」时用。换端口就改这里',
              },
              'worlds.kookvoice.voiceId': {
                type: 'string',
                title: '音色',
                description: '嗓子从插件来时由那个插件决定，这里不生效',
                'x-options': 'voiceId',
              },
              'worlds.kookvoice.ears': {
                type: 'boolean',
                title: '开耳朵',
                description: '关掉就只做「文字 → 念出来」，不听声音',
              },
              'worlds.kookvoice.autoTts': {
                type: 'boolean',
                title: '自己拉起嗓子',
                description: '只在「嗓子来源 = 自己拉起」时有用',
              },
            },
          },
        },
        {
          id: 'kookvoice-path',
          owner: `world:${ID}`,
          title: '路径',
          description: '换机器或者换了安装位置才需要改。',
          schema: {
            type: 'object',
            properties: {
              'worlds.kookvoice.engineDir': {
                type: 'string',
                title: '引擎目录',
                description: 'bridge.mjs 和 ear.py 所在的目录',
                'x-path': { kind: 'directory' },
              },
              'worlds.kookvoice.gsvDir': {
                type: 'string',
                title: 'GPT-SoVITS 目录',
                description: '必须是 v5-turbo 那套自备运行时，否则音色会变',
                'x-path': { kind: 'directory' },
              },
              'worlds.kookvoice.ttsConfig': {
                type: 'string',
                title: '推理配置 yaml',
                'x-path': { kind: 'file', extensions: ['yaml', 'yml'] },
              },
            },
          },
        },
      ],
      invoke: async (panel, method, args = []) => {
        if (panel !== PANEL_ID) throw new Error(`未知面板：${panel}`);
        if (method === 'state') return this.status();
        if (method === 'env') return this.env();
        if (method === 'fetchEnv') return this.fetchEnv();
        if (method === 'setToken') return this.setToken(args[0]);
        if (method === 'detect') return this.detect(args[0]);
        if (method === 'pick') return this.pickChannel(args[0], args[1]);
        if (method === 'join') return this.join();
        if (method === 'leave') return this.leave();
        if (method === 'say') return this.say(args[0]);
        if (method === 'restart') {
          await this.leave();
          return this.join();
        }
        throw new Error(`未知方法：${method}`);
      },
    };
  }

  /**
   * 环境自检。面板的「环境」页靠它决定显示什么。
   *
   * 为什么不自己做「一键下载」：GPT-SoVITS 那套运行时 + 权重十几个 G，
   * Coopanion 的 GPTSoVits 插件已经在做这件事（带下载、校验、版本管理）。
   * 我们再抄一遍只会多一套要维护的安装器，还容易下重复。
   * 所以这里只负责「查清楚缺什么」，然后把人指到那个插件去。
   */
  async env() {
    const d = this.engineDir;
    const gsv = String(this.cfg('gsvDir', DEFAULT_GSV));
    const yaml = String(this.cfg('ttsConfig', DEFAULT_TTS_CFG));
    const has = (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    };

    const tts = this.ttsUrl();
    let ttsPort = PLUGIN_TTS_PORT;
    try {
      ttsPort = Number(new URL(tts).port || 80);
    } catch {}
    const pluginUp = await portOpen(ttsPort);
    const selfUp = await portOpen(TTS_PORT);
    const gsvOk = has(path.join(gsv, 'runtime', 'python.exe'));
    // 大件可能在两个地方：用户数据目录（下载的）或引擎自带目录（开发/离线安装）。
    // 任一处能找到就算就绪 —— 之前只查 data 目录，把已经放在引擎里的模型误判成「缺失」。
    const dataRoot = this.dataDir ? path.join(this.dataDir, 'kookvoice') : '';
    const modelCandidates = [dataRoot ? path.join(dataRoot, 'models') : '', path.join(d, 'p2', 'models')].filter(Boolean);
    const binCandidates = [
      dataRoot ? path.join(dataRoot, 'bin') : '',
      path.join(d, 'p0', 'bin'),
    ].filter(Boolean);
    const pick = (dirs, ...rel) => {
      for (const dir of dirs) {
        const p = path.join(dir, ...rel);
        if (has(p)) return p;
      }
      return path.join(dirs[0] || '', ...rel);
    };
    const asrPath = pick(modelCandidates, 'sense-voice', 'model.int8.onnx');
    const vadPath = pick(modelCandidates, 'vad', 'silero_vad.onnx');
    const ffmpegPath = pick(binCandidates, 'ffmpeg.exe');
    const asrOk = has(asrPath);
    const vadOk = has(vadPath);
    const modelsOk = asrOk && vadOk;
    const ffmpegOk = has(ffmpegPath);
    const modelRoot = path.dirname(path.dirname(asrPath));

    // 服务在跑的话，顺便问问它叫什么（FastAPI 都带 openapi.json）——
    // 这样面板上能看到真实名字，而不是我瞎猜的「GPTSoVits 插件」
    let ttsTitle = '';
    if (pluginUp) {
      try {
        const base = tts.replace(/\/tts\/?$/, '');
        const r = await fetch(`${base}/openapi.json`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) ttsTitle = (await r.json())?.info?.title || '';
      } catch {}
    }

    return {
      items: [
        {
          name: '语音引擎',
          ok: has(path.join(d, 'p1', 'bridge.mjs')),
          detail: d,
          hint: 'bridge.mjs / ear.py 所在目录，插件不自带',
        },
        {
          name: 'ffmpeg',
          ok: ffmpegOk,
          detail: ffmpegOk ? ffmpegPath : '缺失 —— 推流和音频解码都要它',
          hint: '约 62 MB，一键下载会一起装',
        },
        {
          name: '识别模型',
          ok: modelsOk,
          detail: modelsOk
            ? modelRoot
            : `缺${asrOk ? '' : ' SenseVoice'}${vadOk ? '' : ' + VAD'}，可点下面的按钮一键下载`,
          hint: '约 163 MB，缺了听不见人说话',
        },
        {
          name: '嗓子运行时',
          ok: gsvOk,
          detail: gsv,
          hint: 'GPT-SoVITS 自带 python，约 10 GB（只有「自己拉起」才需要）',
        },
        {
          name: '推理配置',
          ok: has(yaml),
          detail: yaml,
          hint: 'tts_infer.cuda.yaml，通常由 GPTSoVits 插件生成',
        },
        {
          name: '语音服务',
          ok: pluginUp,
          detail: pluginUp
            ? `${tts}${ttsTitle ? ` · ${ttsTitle}` : ''}`
            : `${tts}（连不上）`,
          hint: '推荐复用本机已有的那份，不额外占显存',
        },
        {
          name: '自备服务 9881',
          ok: selfUp,
          detail: selfUp ? '正在运行' : '未运行',
          hint: '只在「嗓子来源 = 自己拉起」时用',
        },
      ],
      recommend: pluginUp ? 'plugin' : gsvOk ? 'self' : 'none',
      modelsOk,
      ffmpegOk,
      // 大件齐不齐（面板据此决定要不要显示下载按钮）
      ready: modelsOk && ffmpegOk,
      advice: !modelsOk || !ffmpegOk
        ? `还缺${!ffmpegOk ? ' ffmpeg' : ''}${!modelsOk ? ' 识别模型' : ''}（合计约 225 MB）。点下面的「下载依赖」，下完就能听人说话了；中断了再点一次会接着下。`
        : pluginUp
          ? '环境齐了，直接进频道就行。'
          : gsvOk
            ? '没检测到语音服务在跑。要么去那个插件页面点「推理服务 · 启动」，要么把嗓子来源改成「自己拉起」。'
            : '这台机器还没有能说话的嗓子。最快的办法是去 Coopanion 的扩展页装「GPTSoVits 语音」，它会自己下载运行时和权重；装好回来把嗓子来源设成「插件」即可。',
    };
  }

  /**
   * 把听到的话投给她本人（Coopanion 的主循环），而不是引擎自己去问另一个模型。
   *
   * 走 host.pushEvent：事件进她的事件总线，她带着人设、记忆和当前上下文处理，
   * 想说话就调 kook_speak —— 这样 KOOK 里的话也是「她说的」，会进她的记忆。
   * origin 用默认的 external（KOOK 里是别人说的话，属于外部内容）。
   */
  async deliverToPersona(text) {
    const host = this.host;
    if (!host?.pushEvent) {
      this.pushLog('! 宿主不提供 pushEvent，没法交给她本人');
      return false;
    }
    try {
      await host.pushEvent({
        type: 'kookvoice.heard',
        ts: new Date().toISOString(),
        source: ID,
        text:
          `（KOOK 语音频道里，有人对着你说：）${text}\n` +
          '（这是语音不是打字。想回应就调用 kook_speak 把话说出去，一到三句口语；不想理就别调。）',
        meta: { kind: 'voice', via: 'kook' },
      });
      this.snap.lastHeard = text;
      return true;
    } catch (e) {
      this.pushLog(`! 投递失败：${e?.message ?? e}`);
      return false;
    }
  }

  /** 让她在频道里说一句（面板上的试听就是走这里）。 */
  async say(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, message: '没内容' };
    if (!this.proc) return { ok: false, message: '还没进频道，先说不了话' };
    try {
      this.proc.stdin.write(`/say ${t}\n`);
      return { ok: true, message: `让她说：${t}` };
    } catch (e) {
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  /** 给工具用的一段人话。 */
  statusText() {
    const s = this.snap;
    if (!s.running) {
      return s.error
        ? `现在不在语音频道里。上次出错：${s.error}`
        : '现在不在语音频道里。想让我进去就说一声。';
    }
    return `我在「${s.channel || '?'}」语音频道里听着，用的是 ${s.voice || '?'} 的声音。`;
  }

  // ── 对外（工具 / 面板都能调）────────────────────────────────
  status() {
    // 她本人回答时，真正干活的是 Coopanion 主循环的模型 —— 这个只能问宿主要，
    // 不能拿引擎日志里那个备用大脑冒充（两者可能不是同一个模型）。
    let personaModel = '';
    try {
      personaModel = this.host?.modelFacts?.model?.() || '';
    } catch {}
    return {
      ...this.snap,
      channelId: String(this.cfg('channelId', '')),
      answerBy: String(this.cfg('answerBy', 'persona')),
      personaModel,
      // 三种来源任一有就算有令牌：面板填的、环境变量、引擎目录里的 token.txt
      hasToken:
        !!String(this.cfg('kookToken', '')).trim() ||
        !!String(process.env.KOOK_TOKEN || '').trim() ||
        fs.existsSync(path.join(this.engineDir, 'p0', 'token.txt')),
      engineDir: this.engineDir,
      node: this.proc ? 'running' : '-',
      logs: this.logs.slice(-40),
    };
  }

  /**
   * 一键下载缺失的模型（约 230 MB）。
   * 复用 p2/fetch-env.mjs（清单在 docs/ENVIRONMENT.md），进度直接流进引擎输出。
   * 已经下好的会跳过，所以中断了再点一次就行。
   */
  async fetchEnv() {
    if (this.fetching) return { ok: false, message: '正在下载，别急' };
    const script = path.join(this.engineDir, 'p2', 'fetch-env.mjs');
    if (!fs.existsSync(script)) {
      return { ok: false, message: `找不到下载器：${script}（先检查「引擎目录」）` };
    }
    const { cmd: node, extraEnv } = findNode();
    this.fetching = true;
    this.pushLog('· 开始下载模型（约 230 MB，取决于网速）');
    try {
      const p = spawn(node, [script], {
        cwd: path.dirname(script),
        env: { ...process.env, ...extraEnv, COO_DATA_DIR: this.dataDir },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const onOut = (raw) => {
        for (const line of String(raw).split(/\r?\n/)) {
          const s = line.trim();
          if (!s) continue;
          this.pushLog('  ' + s);
          if (s.startsWith('[fetch-done]')) {
            try {
              this.snap.modelsOk = JSON.parse(s.slice('[fetch-done]'.length)).ok === true;
            } catch {}
          }
        }
      };
      p.stdout.on('data', onOut);
      p.stderr.on('data', onOut);
      p.on('close', (code) => {
        this.fetching = false;
        this.pushLog(code === 0 ? '· 模型下载完成，可以进频道了' : `! 下载结束（code=${code}），缺什么再点一次`);
      });
      p.on('error', (e) => {
        this.fetching = false;
        this.pushLog(`! 下载器起不来：${e?.message ?? e}`);
      });
      return { ok: true, message: '开始下载，进度看下面的引擎输出（约 230 MB）' };
    } catch (e) {
      this.fetching = false;
      return { ok: false, message: String(e?.message ?? e) };
    }
  }

  /** 令牌：优先存配置；配置存不了就写 engine/p0/token.txt（引擎的 loadToken 会读它） */
  setToken(token) {
    const t = String(token || '').trim();
    let saved = false;

    if (typeof this.ctx?.persist === 'function') {
      try {
        this.ctx.persist({ kookToken: t });
        saved = true;
      } catch {}
    }

    if (!saved) {
      try {
        const f = path.join(this.engineDir, 'p0', 'token.txt');
        if (t) fs.writeFileSync(f, t + '\n', 'utf8');
        else if (fs.existsSync(f)) fs.unlinkSync(f);
        saved = true;
      } catch (e) {
        return { ok: false, message: `保存失败：${e?.message ?? e}` };
      }
    }

    if (t) process.env.KOOK_TOKEN = t;
    else delete process.env.KOOK_TOKEN;

    this.pushLog(t ? '· 令牌已保存' : '· 令牌已清空');
    return { ok: true, message: t ? '令牌已保存，可以去检测频道了' : '令牌已清空' };
  }

  /** 面板靠 ctx.invoke('state') 拿数据。payload/status 是早期兼容猜测，已确认不需要。 */
  state() {
    return this.status();
  }

  async join() {
    if (this.proc) return { ok: true, ...this.status(), message: '已经在语音频道里了。' };
    if (this.leaving) return { ok: false, ...this.status(), message: '正在退出频道，等它退完再进' };
    if (this.starting) return { ok: true, ...this.status(), message: '正在进，稍等一下。' };
    // 必须先在面板上选好频道。没选过就进频道等于把桌宠扔进一个不知道哪儿的地方。
    const chosen = String(this.cfg('channelId', '')).trim();
    if (!chosen) {
      return { ok: false, ...this.status(), message: '先在「频道」里点「检测」，选一个语音频道，再点进频道' };
    }
    this.starting = true;
    this.snap.phase = 'starting';
    this.snap.error = '';
    try {
      const dir = path.join(this.engineDir, 'p1');
      const entry = path.join(dir, 'bridge.mjs');
      if (!fs.existsSync(entry)) {
        return this.fail(`找不到引擎：${entry}（在设置里改「引擎目录」）`);
      }

      // 嗓子没开就先拉起来，否则她只能听、不能出声。
      // 失败也照样进频道（可能就是想先听听），但返回语里要说清楚 ——
      // 否则面板看着正常、实际一句都说不出，人会以为插件坏了。
      let ttsOk = true;
      if (this.cfg('autoTts', true)) ttsOk = await this.ensureTts();

      this.spawnBridge(dir, entry);
      return {
        ok: true,
        ...this.status(),
        message: ttsOk
          ? '正在进语音频道，大约十几秒。'
          : '进了频道，但嗓子没起来 —— 她只能听、说不出话。去看「环境」页哪项红了。',
      };
    } finally {
      this.starting = false;
    }
  }

  async leave() {
    // 退出要等 2.5 秒（让 bridge 先退频道再被杀）。这期间必须挡住 join，
    // 否则新进程会去抢同一个 RTP 端口，绑定失败。
    if (this.leaving) return { ok: true, ...this.status(), message: '正在退，稍等' };
    const proc = this.proc;
    if (!proc) {
      this.snap.running = false;
      this.snap.phase = 'idle';
      return { ok: true, ...this.status(), message: '本来就不在频道里。' };
    }
    this.leaving = true;
    this.proc = null;
    this.snap.running = false;
    this.snap.phase = 'idle';
    this.snap.channel = '';
    try {
      // bridge 收到 quit 会先退频道再退出，给它一点时间
      proc.stdin?.write('quit\n');
      await sleep(2500);
      if (proc.exitCode === null) proc.kill();
    } catch {
      try { proc.kill(); } catch {}
    } finally {
      this.leaving = false;
    }
    return { ok: true, ...this.status(), message: '已经退出语音频道。' };
  }

  // ── 内部 ────────────────────────────────────────────────────
  fail(message) {
    this.snap.phase = 'error';
    this.snap.error = message;
    this.snap.running = false;
    this.host?.log?.warn?.(`kookvoice: ${message}`);
    return { ok: false, ...this.status(), message };
  }

  /** plugin 模式要连的语音服务地址（可配置，端口不一定是 9880） */
  ttsUrl() {
    return String(this.cfg('ttsUrl', `http://127.0.0.1:${PLUGIN_TTS_PORT}/tts`)).trim();
  }

  /**
   * 唤醒词的实际值：配置里填了用填的，没填就用她在 Coopanion 里的名字。
   * 启动时和 tick 里比对必须走同一个函数 —— 曾经因为两处写法不同
   * （一处带 botName 兜底、一处只读配置），每 5 秒都判定「变了」，无限重启引擎。
   */
  wakeOf() {
    return String(this.cfg('wakeWords', '')).trim() || String(this.ctx?.botName ?? '').trim();
  }

  async ensureTts() {
    const source = String(this.cfg('ttsSource', 'plugin'));

    // plugin：复用本机已有的语音服务。
    // 不绑定某个插件名字 —— 只要那个地址在跑、接受 {text}，就能用。
    if (source === 'plugin') {
      let port = PLUGIN_TTS_PORT;
      try {
        port = Number(new URL(this.ttsUrl()).port || 80);
      } catch {}
      if (await portOpen(port)) {
        this.snap.tts = true;
        this.snap.ttsAt = this.ttsUrl().replace(/^https?:\/\//, '');
        return true;
      }
      this.snap.tts = false;
      this.snap.ttsAt = '服务未运行';
      this.pushLog(`! 语音服务没在跑（${this.ttsUrl()} 连不上）`);
      this.pushLog('  → 去你那个语音插件页面点「推理服务 · 启动」');
      this.pushLog('  → 或者把「嗓子从哪来」改成「自己拉起一份」，再把地址留空');
      return false;
    }

    // self：自己拉一份
    if (await portOpen(TTS_PORT)) {
      this.snap.tts = true;
      this.snap.ttsAt = `自备（${TTS_PORT}）`;
      return true;
    }
    // 直接 spawn python.exe 并隐藏窗口。
    // 以前是 `cmd /c start "CooTTS" /min start-tts.bat` —— bat 里有 pause，
    // 只能那样起，代价是任务栏多一个控制台窗口。插件里不该再往外弹窗。
    const home = String(this.cfg('gsvDir', DEFAULT_GSV));
    const py = path.join(home, 'runtime', 'python.exe');
    const cfgYaml = String(this.cfg('ttsConfig', DEFAULT_TTS_CFG));
    if (!fs.existsSync(py)) {
      this.pushLog(`! 找不到嗓子运行时：${py}（在设置里改「GPT-SoVITS 目录」）`);
      this.snap.tts = false;
      return false;
    }
    if (!fs.existsSync(cfgYaml)) {
      this.pushLog(`! 找不到推理配置：${cfgYaml}`);
      this.snap.tts = false;
      return false;
    }

    let out = 'ignore';
    try {
      const logDir = path.join(this.engineDir, 'p1', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      out = fs.openSync(path.join(logDir, 'tts.log'), 'a');
    } catch {}

    this.pushLog('· 嗓子没开，正在拉起 GPT-SoVITS（冷启动 30～60 秒，不弹窗，日志在 p1/logs/tts.log）');
    try {
      spawn(
        py,
        ['-I', '-X', 'utf8', '-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(TTS_PORT), '-c', cfgYaml],
        { cwd: home, windowsHide: true, detached: true, stdio: ['ignore', out, out] },
      ).unref();
    } catch (e) {
      this.pushLog(`! 拉嗓子失败：${e?.message ?? e}`);
      this.snap.tts = false;
      return false;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      if (await portOpen(TTS_PORT)) {
        this.snap.tts = true;
        this.pushLog(`✓ 嗓子就绪（${(i + 1) * 2}s）`);
        return true;
      }
    }
    this.snap.tts = false;
    this.pushLog('! 嗓子没起来，她这次只能听不能说');
    return false;
  }

  spawnBridge(dir, entry) {
    const { cmd: node, extraEnv } = findNode();
    const args = [entry];
    if (!this.cfg('ears', true)) args.push('--no-ear');
    const channel = String(this.cfg('channelId', '')).trim();
    const replyMode = String(this.cfg('replyMode', 'always'));
    // 唤醒词没填就用她在 Coopanion 里的名字 —— 别人家的桌宠叫什么自己带过来
    const wake = this.wakeOf();
    if (replyMode === 'name') {
      this.pushLog(`· 唤醒词：${wake || '（没设置，谁叫都不应）'}（叫名字才接）`);
    }

    this.pushLog(`· 启动引擎：${node} ${entry}`);
    const proc = spawn(node, args, {
      cwd: dir,
      env: {
        ...process.env,
        ...extraEnv,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        FORCE_COLOR: '0',
        // 这三个用环境变量覆盖 bridge.json，免得插件去改引擎的配置文件
        COO_CHANNEL_ID: channel,
        COO_VOICE: String(this.cfg('voiceId', '')),
        COO_REPLY_MODE: replyMode,
        COO_ALIASES: wake,
        // persona = 引擎只听话不回答，把话交给主循环让她本人回；self = 引擎自己调模型
        COO_ANSWER_BY: String(this.cfg('answerBy', 'persona')),
        // 嗓子走谁：插件（9880，简化接口只收 text）还是自备（9881，api_v2）
        COO_TTS_URL: String(this.cfg('ttsSource', 'plugin')) === 'plugin' ? this.ttsUrl() : '',
        COO_TTS_STYLE: String(this.cfg('ttsSource', 'plugin')) === 'plugin' ? 'coopanion' : '',
        // 模型和 ffmpeg 的实际位置（空 = 用引擎目录下的默认布局，开发环境就是这样）
        COO_DATA_DIR: this.dataDir,
        COO_FFMPEG: this.ffmpegPath,
        // 令牌走环境变量，引擎的 loadToken() 会优先读它
        KOOK_TOKEN: String(this.cfg('kookToken', '')).trim(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    // 记下这次启动用的参数，tick 里拿它跟当前配置比对，变了就自动重启
    this.spawnedCfg = {
      replyMode,
      wakeWords: wake,
      voiceId: String(this.cfg('voiceId', '')),
      channelId: channel,
      ttsSource: String(this.cfg('ttsSource', 'plugin')),
      answerBy: String(this.cfg('answerBy', 'persona')),
      ears: !!this.cfg('ears', true),
    };
    this.snap.since = Date.now();

    proc.stdin?.on('error', () => {});
    proc.on('error', (e) => this.fail(`引擎起不来：${e?.message ?? e}`));

    const onLine = (raw) => {
      for (const line of String(raw).split(/\r?\n/)) {
        const s = line.trim();
        if (s) this.readLine(s);
      }
    };
    let bufOut = '';
    proc.stdout.on('data', (d) => {
      bufOut += d.toString('utf8');
      let nl;
      while ((nl = bufOut.indexOf('\n')) >= 0) {
        const line = bufOut.slice(0, nl);
        bufOut = bufOut.slice(nl + 1);
        // 逐行兜住异常：readLine 跑在 socket 回调里，抛出去就是 uncaught exception，
        // 会把整个 Coopanion 带崩。宁可丢这一行日志，也不能让她重启。
        try {
          this.readLine(line.trim());
        } catch (e) {
          this.pushLog(`! 解析输出出错：${e?.message ?? e}`);
        }
      }
    });
    proc.stderr.on('data', (d) => onLine(d.toString('utf8')));

    proc.on('exit', (code) => {
      this.pushLog(`· 引擎退出 code=${code}`);
      if (this.proc === proc) {
        this.proc = null;
        if (this.snap.running) {
          this.snap.running = false;
          this.snap.phase = code === 0 ? 'idle' : 'error';
          if (code !== 0) this.snap.error = `引擎退出（code=${code}）`;
        }
      }
    });
  }

  /** 从引擎输出里认出关键状态，其余只压进日志环。 */
  readLine(line) {
    this.pushLog(line);
    if (!line) return;

    // persona 模式下引擎不自己回答，只把听到的话交出来，这里转投给主循环。
    // 格式：[投递] {"text":"...","dur":1.6,"peak":0.05}
    if (line.startsWith('[投递] ')) {
      try {
        const d = JSON.parse(line.slice(5));
        const text = String(d.text || '').trim();
        if (text) {
          this.pushLog(`· 交给她本人：${text}`);
          void this.deliverToPersona(text);
        }
      } catch {}
      return;
    }

    let m;
    if ((m = line.match(/语音频道「(.+?)」/))) {
      this.snap.channel = m[1];
      this.snap.running = true;
      this.snap.phase = 'listening';
      this.snap.error = '';
      // 这里**不推事件**。
      // 一是不该用 ('type', payload) 这种两参写法 —— pushEvent 只收一个事件对象，
      // 传错会变成 type: undefined，主循环读到直接崩（2026-11-07 踩过，桌宠会重启）。
      // 二是进频道只是状态变化，envPromptVars 已经能让她知道自己在语音里；
      // 推事件会触发一轮模型，表现为「每次进频道她都主动说一句」。
      return;
    }
    if ((m = line.match(/当前音色：(.+?)（/))) {
      this.snap.voice = m[1];
      return;
    }
    if ((m = line.match(/大脑就绪（\S+ \/ (.+?)）/))) {
      this.snap.model = m[1];
      return;
    }
    if (line.includes('耳朵已就绪')) {
      this.snap.phase = 'listening';
      this.snap.running = true;
      return;
    }
    if (line.includes('嗓子没起来')) {
      this.snap.tts = false;
      return;
    }
    if (line.startsWith('✗') || line.startsWith('! 嗓子')) {
      this.snap.error = line.replace(/^[✗!]\s*/, '');
      if (line.includes('回答失败') || line.includes('嗓子')) this.snap.phase = 'error';
    }
  }

  pushLog(line) {
    this.logs.push(line);
    if (this.logs.length > LOG_KEEP) this.logs.splice(0, this.logs.length - LOG_KEEP);
  }
}
