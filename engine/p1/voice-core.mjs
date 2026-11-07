// 语音核心：一条永不断开的 RTP 流 + TTS 合成 + 静音填充
//
// 为什么必须常驻：KOOK 的推流地址在第一次推流后就和 IP+端口绑定，第二次推同一地址必失败。
// 所以不能「说一句起一个 ffmpeg」，只能把 TTS 的 PCM 塞进同一条 ffmpeg 的 stdin，没话说时填静音。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { api, loadToken, HERE } from '../p0/kook.mjs';

// ffmpeg 放哪：优先 COO_FFMPEG（用户数据目录里下载的），
// 其次引擎自带的 p0/bin，最后交给 PATH。
export const FFMPEG = [
  process.env.COO_FFMPEG,
  path.join(HERE, 'bin', 'ffmpeg.exe'),
  path.join(HERE, 'bin', 'ffmpeg'),
  'ffmpeg',
]
  .filter(Boolean)
  .find((p) => p === 'ffmpeg' || fs.existsSync(p));

// 嗓子配置：p1/tts.json。这里存两样东西——
//   ① 服务地址（我们自己起的 GPT-SoVITS 推理服务，默认 9881）
//   ② 音色（参考音频 + 它的原文 + 语言）
// 语言坑：textLang 曾被设成 ja，Coo 唱中文就带日语口音，ASR 会听成假名。必须 zh。
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
function loadTtsConfig() {
  const p = path.join(SELF_DIR, 'tts.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const TTS = loadTtsConfig();
export const TTS_URL = process.env.COO_TTS_URL || TTS.url || 'http://127.0.0.1:9881/tts';

// ── 音色库 ──────────────────────────────────────────────────────
// tts.json 管「服务和语速」，voices.json 管「用谁的声音」。
// 拆开是为了以后能在运行中换音色，不用重启整个 bridge。
const VOICES_PATH = path.join(SELF_DIR, 'voices.json');
function readVoices() {
  try {
    return JSON.parse(fs.readFileSync(VOICES_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { current: null, list: [] };
  }
}
let VOICES = readVoices();

export function listVoices() {
  return (VOICES.list || []).map((v) => ({ ...v, active: v.id === VOICES.current }));
}

export function currentVoice() {
  const list = VOICES.list || [];
  // 插件可以在启动时用环境变量指定音色，不用改 voices.json
  const forced = process.env.COO_VOICE;
  if (forced) {
    const hit = list.find((v) => v.id === forced || v.name === forced);
    if (hit) return hit;
  }
  return list.find((v) => v.id === VOICES.current) || list[0] || null;
}

/** 切换音色并写回 voices.json（保留注释和原格式，只改 current 那一行） */
export function setVoice(id) {
  const list = VOICES.list || [];
  const v = list.find((x) => x.id === id) || list.find((x) => x.name === id);
  if (!v) return null;
  VOICES.current = v.id;
  try {
    const raw = fs.readFileSync(VOICES_PATH, 'utf8');
    const next = raw.replace(/"current"\s*:\s*"[^"]*"/, `"current": "${v.id}"`);
    if (next !== raw) fs.writeFileSync(VOICES_PATH, next, 'utf8');
  } catch {}
  return v;
}

export function reloadVoices() {
  VOICES = readVoices();
  return currentVoice();
}

/** 把 tts.json 翻成对应接口要的请求体 */
export function ttsBody(text) {
  // 插件可以用环境变量临时换成别的嗓子服务（比如 Coopanion 的 GPTSoVits 插件 9880），
  // 那种简化接口只收 { text }，语言和音色都由插件自己那份配置决定。
  const style = process.env.COO_TTS_STYLE || TTS.style || 'api_v2';
  if (style === 'coopanion') return { text };
  const v = currentVoice(); // 没有 voices.json 时退回 tts.json 的老字段
  return {
    text,
    text_lang: TTS.textLang || 'zh',
    ref_audio_path: v ? v.refAudio : TTS.refAudio,
    prompt_text: v ? v.promptText : (TTS.promptText || ''),
    prompt_lang: v ? (v.promptLang || 'zh') : (TTS.promptLang || 'zh'),
    text_split_method: 'cut5',
    speed_factor: TTS.speed ?? 1.0,
    // 切句后每段之间插的静音；默认 0.3 会让逗号处一顿一顿
    fragment_interval: TTS.fragmentInterval ?? 0.1,
    parallel_infer: TTS.parallelInfer !== false,
    streaming_mode: 0,
  };
}

/** 把 fetch 的原始错误翻成人话——「fetch failed」这种提示对使用者等于没说 */
function explainTtsError(e, url) {
  const code = e?.cause?.code || e?.code;
  if (code === 'ECONNREFUSED' || e?.message === 'fetch failed') {
    return `嗓子没开：连不上 ${url}\n     → 双击 p1\\start-tts.bat 起 GPT-SoVITS（冷启动 30–60 秒），或重启 start-coo.bat 会自动拉起`;
  }
  if (e?.name === 'TimeoutError') return `嗓子超时：${url} 没在 ${Math.round((TTS.timeoutMs || 180000) / 1000)}s 内合成完，模型可能还在加载`;
  return e?.message || String(e);
}

/** 探测 TCP 端口是否已有人监听（TTS 服务冷启动要几十秒，得等） */
export function probePort(url = TTS_URL) {
  const u = new URL(url);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(1200, () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** 等 TTS 服务就绪；每 2 秒探一次 */
export async function waitTts(timeoutMs = 90000, log = () => {}) {
  const t0 = Date.now();
  let announced = false;
  while (Date.now() - t0 < timeoutMs) {
    if (await probePort()) return true;
    if (!announced && Date.now() - t0 > 3000) {
      announced = true;
      log(`· 等嗓子（GPT-SoVITS ${new URL(TTS_URL).host}）就绪，模型冷启动要 30–60 秒 …`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// 48kHz / 立体声 / s16le → 每毫秒 192 字节
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * 2) / 1000;
const TICK_MS = 20;
/** 每句话前面垫的静音时长（毫秒），见 speak() 里的说明 */
const SPEAK_PAD_MS = 150;

/** PCM 队列：读不够就用 0（静音）补齐，保证推流永远不断 */
export class PcmQueue {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.bytes = 0;
  }
  push(buf) {
    if (!buf || !buf.length) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
  }
  clear() {
    this.chunks = [];
    this.offset = 0;
    this.bytes = 0;
  }
  get pendingMs() {
    return Math.round(this.bytes / BYTES_PER_MS);
  }
  /** 取 n 字节；不足的部分是静音 */
  take(n) {
    const out = Buffer.alloc(n); // 0 = 静音
    let filled = 0;
    while (filled < n && this.chunks.length) {
      const cur = this.chunks[0];
      const avail = cur.length - this.offset;
      const len = Math.min(avail, n - filled);
      cur.copy(out, filled, this.offset, this.offset + len);
      filled += len;
      this.offset += len;
      this.bytes -= len;
      if (this.offset >= cur.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }
}

export class VoiceStream {
  constructor(channelId, { password, bitrateLimit, ttsUrl } = {}) {
    this.channelId = channelId;
    this.password = password;
    this.bitrateLimit = bitrateLimit;
    this.ttsUrl = ttsUrl || TTS_URL;

    this.queue = new PcmQueue();
    this.proc = null;
    this.keepAlive = null;
    this.ticker = null;
    this.sentMs = 0;
    this.startedAt = 0;
    this.joined = false;
    this.speaking = false;
    /** 队列由有变空时触发，用于半双工录音闸门 */
    this.onIdle = null;
    this.onStart = null;
    /** 每合成一句就回调一次 (wavBuffer, text)，给本地监听用。
     *  KOOK 不会把推上去的声音播回来，单人测试全靠这条路确认「她真说话了」 */
    this.monitor = null;
  }

  async join() {
    const token = loadToken();
    this.token = token;
    const body = { channel_id: this.channelId };
    if (this.password) body.password = this.password;
    const info = await api('POST', '/voice/join', { token, body });
    this.info = info;
    this.joined = true;
    return info;
  }

  start() {
    const { ip, port, bitrate, audio_ssrc, audio_pt, rtcp_mux, rtcp_port } = this.info;
    const noMux = rtcp_mux === false || rtcp_mux === 'false' || rtcp_mux === 0;
    const addr = noMux ? `rtp://${ip}:${port}?rtcpport=${rtcp_port}` : `rtp://${ip}:${port}`;
    const tee = `[select=a:f=rtp:ssrc=${audio_ssrc}:payload_type=${audio_pt}]${addr}`;

    // 服务端下发的码率上限，别贴线（超 120% 会被断开甚至处罚）
    const serverKbps = Math.floor(Number(bitrate) / 1000);
    const kbps = Math.min(this.bitrateLimit || serverKbps, serverKbps);
    this.kbps = kbps;

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', 'pipe:0',
      // 必须显式 map：tee muxer 在没有 -map 时会认为「不想输出任何流」
      '-map', '0:a:0',
      '-acodec', 'libopus', '-b:a', `${kbps}k`,
      '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      '-f', 'tee', tee,
    ];

    this.proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    // ffmpeg 被结束（或推流断开）后再写 stdin 会抛 EPIPE；不吞掉就是未捕获异常，
    // 表现为「退出时反而崩溃，leave 没跑完」。安静忽略即可。
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', () => {});

    this.proc.stderr.on('data', (d) => {
      // 这几条是这个 ffmpeg 构建的 UDP 输出噪音，不影响推流，过滤掉
      const NOISE = /circular_buffer_size|Guessed Channel Layout|Input Stream #0\.0 : (stereo|mono)/i;
      for (const line of d.toString().split(/\r?\n/)) {
        const s = line.trim();
        if (s && !NOISE.test(s)) process.stderr.write(`[ffmpeg] ${s}\n`);
      }
    });
    this.proc.on('error', (e) => {
      console.error(`✗ ffmpeg 起不来：${e.message}`);
      this.leave();
    });
    this.proc.on('exit', (code) => {
      if (code !== 0 && code !== null) console.error(`✗ ffmpeg 退出了 code=${code}`);
    });

    // 按真实时间推进，避免 setInterval 抖动累积成漂移
    // （14:47 那版就是内联在这里的；抽成方法后出过「定时器在、队列不动」的怪事，别再抽）
    this.startedAt = Date.now();
    this.sentMs = 0;
    this.ticker = setInterval(() => {
      const target = Date.now() - this.startedAt;
      let need = target - this.sentMs;
      if (need < TICK_MS) return;
      // 卡顿后不要一次性爆冲补回来，最多补 200ms
      if (need > 200) {
        need = 200;
        this.startedAt = Date.now() - this.sentMs - need;
      }
      this.sentMs += need;
      const buf = this.queue.take(Math.round(need * BYTES_PER_MS));
      if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(buf);

      const wasSpeaking = this.speaking;
      this.speaking = this.queue.bytes > 0;
      if (!wasSpeaking && this.speaking && this.onStart) this.onStart();
      if (wasSpeaking && !this.speaking && this.onIdle) this.onIdle();
    }, TICK_MS);

    // 长时间断流会被回收端口
    // 顺便记失败次数：连续三次（约 2 分钟）基本可以确定已经被踢出频道了，
    // 置 lost 交给上层重连。不这么做的话，面板一直显示「在听」，实际早就掉线了。
    this.keepAliveFails = 0;
    this.lost = false;
    this.keepAlive = setInterval(() => {
      api('POST', '/voice/keep-alive', { token: this.token, body: { channel_id: this.channelId } })
        .then(() => {
          this.keepAliveFails = 0;
        })
        .catch((e) => {
          this.keepAliveFails = (this.keepAliveFails || 0) + 1;
          console.error(`! keep-alive 失败（第 ${this.keepAliveFails} 次）：${e.message}`);
          if (this.keepAliveFails >= 3) this.lost = true;
        });
    }, 45_000);
    this.keepAlive.unref();

    return { addr, kbps };
  }


  /** wav → 48k 立体声 s16le PCM */
  /** wav → 48k 立体声 s16le PCM（回退版：同步解码，跟 14:47 那版一致） */
  wavToPcm(wavBuf) {
    const tmp = path.join(HERE, `.tts-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(tmp, wavBuf);
    try {
      const r = spawnSync(
        FFMPEG,
        ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-'],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      if (r.status !== 0) throw new Error(r.stderr?.toString().slice(0, 200) || 'ffmpeg 解码失败');
      return r.stdout;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  /** 让 Coo 说一句话。interrupt=true 时清掉还在排队的内容 */
  async speak(text, { interrupt = false } = {}) {
    if (!text || !text.trim()) return { ok: false, why: 'empty' };
    if (interrupt) this.queue.clear();

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(this.ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsBody(text.trim())),
        signal: AbortSignal.timeout(TTS.timeoutMs || 180000),
      });
    } catch (e) {
      throw new Error(explainTtsError(e, this.ttsUrl));
    }
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TTS ${res.status}: ${body.slice(0, 200)}`);
    }
    const wav = Buffer.from(await res.arrayBuffer());
    const pcm = this.wavToPcm(wav);
    // 开头垫一小段静音。她说话短句多（「说什么。」只有半秒），
    // KOOK 那边的抖动缓冲容易把短音频的起头吞掉，听感就是「哼」一声。
    // 补 150ms 静音后，切进来的第一帧就是安静的，人耳能听到完整的一句。
    const pad = Buffer.alloc(Math.round(SPEAK_PAD_MS * BYTES_PER_MS));
    this.queue.push(Buffer.concat([pad, pcm]));
    // 本地监听：合成好了就先在本机响一遍，不用等 KOOK 回环
    if (this.monitor) {
      try { this.monitor(wav, text); } catch {}
    }
    return { ok: true, ms, pcmMs: Math.round((pcm.length + pad.length) / BYTES_PER_MS) };
  }

  /** 预热 TTS 模型：冷启动要 20 秒以上，先合成一个短句把模型拉起来
   *  注意只合成、不进播放队列，避免用户听到一个突兀的「嗯」 */
  async warmup() {
    const t0 = Date.now();
    try {
      const res = await fetch(this.ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ttsBody('嗯')),
        signal: AbortSignal.timeout(TTS.timeoutMs || 180000),
      });
      await res.arrayBuffer();
      return Date.now() - t0;
    } catch {
      return -1;
    }
  }

  hush() {
    this.queue.clear();
  }

  async leave() {
    clearInterval(this.ticker);
    clearInterval(this.keepAlive);
    this.ticker = null;
    this.keepAlive = null;
    try { if (this.proc) this.proc.stdin.end(); } catch {}
    try { if (this.proc) this.proc.kill(); } catch {}
    this.proc = null;
    if (this.joined) {
      try {
        await api('POST', '/voice/leave', { token: this.token, body: { channel_id: this.channelId } });
        console.log('✓ 已退出语音频道');
      } catch (e) {
        console.error(`! 退出失败：${e.message}`);
      }
      this.joined = false;
    }
  }
}
