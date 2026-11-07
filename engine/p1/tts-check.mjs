// 嗓子自检：不连 KOOK，只验证「bridge → GPT-SoVITS → wav」这一段通不通。
//
//   node tts-check.mjs                # 说默认那句
//   node tts-check.mjs "随便一句话"    # 说指定的句子
//
// 通过后会在同目录留一个 tts-check.wav，可以自己点开听听是不是她的声音、
// 中文有没有怪口音。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TTS_URL, probePort, ttsBody } from './voice-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = (process.argv.slice(2).join(' ') || '我来了，能听见我吗？').trim();
const host = new URL(TTS_URL).host;

console.log(`嗓子：${TTS_URL}`);
console.log(`要说：${text}`);

if (!(await probePort())) {
  console.error(`✗ 连不上 ${host} —— 服务没起。先双击 start-tts.bat，等它打印出监听信息。`);
  process.exit(1);
}

const t0 = Date.now();
let res;
try {
  res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ttsBody(text)),
    signal: AbortSignal.timeout(180000),
  });
} catch (e) {
  console.error(`✗ 请求失败：${e?.message || e}`);
  console.error('  如果是 ECONNREFUSED，说明服务在探测之后挂了，看 start-tts 那个窗口的报错。');
  process.exit(1);
}

if (!res.ok) {
  console.error(`✗ 合成失败 HTTP ${res.status}`);
  console.error(`  ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}

const wav = Buffer.from(await res.arrayBuffer());
const out = path.join(HERE, 'tts-check.wav');
fs.writeFileSync(out, wav);
const ms = Date.now() - t0;
console.log(`✓ 合成成功 ${ms}ms（${Math.round(wav.length / 1024)}KB）`);
console.log(`  已存 ${out}`);
console.log(`  冷启动第一次会慢（30–60s），之后每句 1.5–3s。`);
