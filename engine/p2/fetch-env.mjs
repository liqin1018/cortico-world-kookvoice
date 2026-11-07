#!/usr/bin/env node
/**
 * 一键下载耳朵需要的模型（约 230 MB）。
 *
 * 数据来源写在 docs/ENVIRONMENT.md，这里只负责按那张表拉文件、校验、解压。
 * 用法：
 *   node p2/fetch-env.mjs           # 缺什么下什么，已就绪的跳过
 *   node p2/fetch-env.mjs --force   # 全部重下
 *   node p2/fetch-env.mjs --check   # 只检查，不下载
 *
 * 输出约定（面板/上层从这里读进度）：
 *   [fetch] <文本>          人类可读的进度
 *   [fetch-done] {json}     结束，{ok, downloaded, skipped, errors}
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 落地目录：
//   公开分发时插件会传 COO_DATA_DIR（Coopanion 的用户数据目录），
//   模型和 ffmpeg 都放到 <data>/kookvoice/ 下，重装插件不会丢。
//   开发环境没传，就按引擎原本的布局：模型在 p2/models，ffmpeg 在 p0/bin。
const DATA = process.env.COO_DATA_DIR ? path.join(process.env.COO_DATA_DIR, 'kookvoice') : '';
const MODELS = DATA ? path.join(DATA, 'models') : path.join(HERE, 'models');
const BIN = DATA ? path.join(DATA, 'bin') : path.join(HERE, '..', 'p0', 'bin');
const TMP = DATA ? path.join(DATA, '.download') : path.join(HERE, '..', '.download');

/** 与 docs/ENVIRONMENT.md 保持一致 */
const SENSE_VOICE = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
  bytes: 163002883,
  archive: 'sense-voice.tar.bz2',
  dir: path.join(MODELS, 'sense-voice'),
  files: [
    {
      name: 'model.int8.onnx',
      sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    },
    {
      name: 'tokens.txt',
      sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    },
  ],
};

const VAD = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  dest: path.join(MODELS, 'vad', 'silero_vad.onnx'),
};

/**
 * ffmpeg —— 语音推流和 wav 解码都靠它。
 * 用 @ffmpeg-installer 的 Windows 构建（4.1，带 libopus），npm 上的 tgz 直链。
 * ⚠️ 这个构建是 **GPL v3**，分发时必须附许可声明（见插件根目录 THIRD-PARTY.md）。
 */
const FFMPEG_BIN = {
  url: 'https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz',
  sha256: 'c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e',
  archive: 'ffmpeg-win64.tgz',
  dest: path.join(BIN, 'ffmpeg.exe'),
  // tgz 里是 package/ffmpeg.exe
  strip: 1,
};

const log = (s) => console.log(`[fetch] ${s}`);

function sha256File(p) {
  return new Promise((resolve) => {
    if (!fs.existsSync(p)) return resolve('');
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(p);
    rs.on('data', (d) => h.update(d));
    rs.on('error', () => resolve(''));
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 用系统 curl 下载。
 * 为什么需要它：如果系统挂了 HTTP(S)_PROXY 且代理做了 TLS 中间人（Clash、公司网关常见），
 * Node 的 fetch 用内置 CA 列表会报 UNABLE_TO_GET_ISSUER_CERT_LOCALLY，
 * 而 curl 走 Windows 证书库，能过。Windows 10 1803+ 自带 curl.exe。
 */
function viaCurl(url, dest) {
  return new Promise((resolve) => {
    const p = spawn('curl', ['-L', '--fail', '--retry', '2', '--retry-delay', '2', '-sS', '-o', dest, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    p.stderr.on('data', (d) => {
      if (err.length < 500) err += d.toString();
    });
    p.on('error', () => resolve({ ok: false, why: '找不到 curl' }));
    p.on('close', (code) => resolve({ ok: code === 0, why: code === 0 ? '' : err.trim() || `curl 退出 ${code}` }));
  });
}

/** 用 fetch 下载，带进度。返回 {ok, why} */
async function viaFetch(url, dest, expectBytes) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    return { ok: false, why: `${e?.message ?? e}${e?.cause?.code ? ` / ${e.cause.code}` : ''}` };
  }
  if (!res.ok || !res.body) return { ok: false, why: `HTTP ${res.status}` };

  const total = Number(res.headers.get('content-length')) || expectBytes || 0;
  let got = 0;
  let lastPct = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    got += chunk.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        log(`  ${pct}%  ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`);
      }
    }
  });
  try {
    await pipeline(src, fs.createWriteStream(dest));
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e?.message ?? String(e) };
  }
}

/** 下载：先 fetch（有进度），不行退 curl（能过代理）。返回 true=成功 */
async function download(url, dest, expectBytes = 0) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch {}

  let r = await viaFetch(url, part, expectBytes);
  if (!r.ok) {
    log(`· fetch 失败（${r.why}），改用系统 curl 重试`);
    try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch {}
    r = await viaCurl(url, part);
    if (!r.ok) {
      log(`✗ 下载失败：${r.why}`);
      try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch {}
      return false;
    }
  }
  try {
    fs.renameSync(part, dest);
    return true;
  } catch (e) {
    log(`✗ 写盘失败：${e?.message ?? e}`);
    return false;
  }
}

/** 用系统 tar 解压（Windows 10 1803+ 自带 bsdtar，同时支持 bz2 和 gz） */
function untar(archive, destDir, gz = false) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    // --strip-components=1：包里套了一层目录，剥掉它直接把文件摊平
    const p = spawn('tar', [gz ? '-xzf' : '-xjf', archive, '-C', destDir, '--strip-components=1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    p.stderr.on('data', (d) => {
      if (err.length < 1000) err += d.toString();
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar 退出 ${code}`))));
  });
}

async function checkFiles(spec) {
  const out = [];
  for (const f of spec.files) {
    const p = path.join(spec.dir, f.name);
    const got = await sha256File(p);
    out.push({ ...f, path: p, actual: got, ok: got === f.sha256 });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const checkOnly = argv.includes('--check');

  let downloaded = 0;
  let skipped = 0;
  const errors = [];

  // ── 1. VAD（629 KB，先下小的，失败了也快）──
  {
    const actual = await sha256File(VAD.dest);
    if (!force && actual === VAD.sha256) {
      log('✓ VAD 已就绪，跳过');
      skipped++;
    } else if (checkOnly) {
      log(`✗ 缺 VAD：${VAD.dest}`);
      errors.push('vad');
    } else {
      log('↓ 下载 Silero VAD（629 KB）');
      if (!(await download(VAD.url, VAD.dest))) {
        errors.push('vad');
      } else {
        const h = await sha256File(VAD.dest);
        if (h !== VAD.sha256) {
          log(`✗ VAD 校验失败（期望 ${VAD.sha256.slice(0, 12)}… 实际 ${h.slice(0, 12)}…）`);
          errors.push('vad');
        } else {
          log('✓ VAD 完成');
          downloaded++;
        }
      }
    }
  }

  // ── 2. ffmpeg（62 MB，推流和解码都靠它）──
  {
    const actual = await sha256File(FFMPEG_BIN.dest);
    if (!force && actual === FFMPEG_BIN.sha256) {
      log('✓ ffmpeg 已就绪，跳过');
      skipped++;
    } else if (checkOnly) {
      log(`✗ 缺 ffmpeg：${FFMPEG_BIN.dest}`);
      errors.push('ffmpeg');
    } else {
      fs.mkdirSync(TMP, { recursive: true });
      const archive = path.join(TMP, FFMPEG_BIN.archive);
      log('↓ 下载 ffmpeg（约 62 MB）');
      if (!(await download(FFMPEG_BIN.url, archive))) {
        errors.push('ffmpeg');
      } else {
        log('· 解压…');
        try {
          await untar(archive, BIN, true);
        } catch (e) {
          log(`✗ 解压失败：${e?.message ?? e}`);
          errors.push('ffmpeg');
        }
        try { fs.unlinkSync(archive); } catch {}
        if (!errors.includes('ffmpeg')) {
          const h = await sha256File(FFMPEG_BIN.dest);
          if (h !== FFMPEG_BIN.sha256) {
            log(`✗ ffmpeg 校验失败（期望 ${FFMPEG_BIN.sha256.slice(0, 12)}… 实际 ${h.slice(0, 12) || '无'}）`);
            errors.push('ffmpeg');
          } else {
            log('✓ ffmpeg 完成');
            downloaded++;
          }
        }
      }
    }
  }

  // ── 3. SenseVoice（163 MB）──
  {
    const files = await checkFiles(SENSE_VOICE);
    const allOk = files.every((f) => f.ok);
    if (!force && allOk) {
      log('✓ SenseVoice 已就绪，跳过');
      skipped++;
    } else if (checkOnly) {
      for (const f of files) if (!f.ok) log(`✗ 缺 ${f.path}`);
      errors.push('sense-voice');
    } else {
      fs.mkdirSync(TMP, { recursive: true });
      const archive = path.join(TMP, SENSE_VOICE.archive);
      log(`↓ 下载 SenseVoice（${(SENSE_VOICE.bytes / 1048576).toFixed(0)} MB，可能要几分钟）`);
      if (!(await download(SENSE_VOICE.url, archive, SENSE_VOICE.bytes))) {
        errors.push('sense-voice');
      } else {
        log('· 解压…');
        try {
          await untar(archive, SENSE_VOICE.dir);
        } catch (e) {
          log(`✗ 解压失败：${e?.message ?? e}`);
          errors.push('sense-voice');
        }
        try { fs.unlinkSync(archive); } catch {}

        if (!errors.includes('sense-voice')) {
          const after = await checkFiles(SENSE_VOICE);
          const bad = after.filter((f) => !f.ok);
          if (bad.length) {
            for (const f of bad) {
              log(`✗ ${f.name} 校验失败（期望 ${f.sha256.slice(0, 12)}… 实际 ${f.actual.slice(0, 12) || '无'}）`);
            }
            errors.push('sense-voice');
          } else {
            log('✓ SenseVoice 完成');
            downloaded++;
          }
        }
      }
    }
  }

  // 清掉空的临时目录
  try {
    if (fs.existsSync(TMP) && !fs.readdirSync(TMP).length) fs.rmdirSync(TMP);
  } catch {}

  const ok = errors.length === 0;
  if (ok) {
    log('全部就绪，可以进频道了。');
  } else {
    log(`还缺：${errors.join(', ')}。检查网络后重跑本脚本即可（已下好的会跳过）。`);
  }
  console.log(`[fetch-done] ${JSON.stringify({ ok, downloaded, skipped, errors })}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  log(`✗ 意外错误：${e?.stack ?? e}`);
  console.log(`[fetch-done] ${JSON.stringify({ ok: false, downloaded: 0, skipped: 0, errors: ['crash'] })}`);
  process.exit(1);
});
