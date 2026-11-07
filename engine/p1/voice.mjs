// 音色管理：列出来 / 切过去 / 试听一句
//
//   node voice.mjs                  列出所有音色，标出当前在用的
//   node voice.mjs use qiong-zh     切换并写回 voices.json（重启 bridge 生效）
//   node voice.mjs test qiong-ja    切过去顺便合成一句，产出 voice-test-<id>.wav
//
// 音色配置在 voices.json。promptText 必须和参考音频的真实内容一致 ——
// 差一个字，合成会退化成一团几百毫秒的碎片，而不是报错。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVoices, currentVoice, setVoice, ttsBody, TTS_URL } from './voice-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = '今天天气不错，我们出去走走吧。';

const [, , cmd = 'list', arg] = process.argv;

function show() {
  const cur = currentVoice();
  console.log(`\n当前音色：${cur ? `${cur.name}  (${cur.id})` : '(未配置，回落到 tts.json)'}\n`);
  for (const v of listVoices()) {
    console.log(` ${v.active ? '▶' : ' '} ${v.id.padEnd(10)} ${v.name.padEnd(12, '　')} ${v.note || ''}`);
  }
  console.log('\n  切换  node voice.mjs use <id>');
  console.log('  试听  node voice.mjs test <id>');
  console.log('  改完要重启 bridge 才生效\n');
}

async function test(id) {
  if (id) {
    const v = setVoice(id);
    if (!v) {
      console.error(`✗ 没有这个音色：${id}`);
      console.error(`  可用的：${listVoices().map((x) => x.id).join(' / ')}`);
      process.exit(1);
    }
    console.log(`· 已切到「${v.name}」（${v.id}），已写回 voices.json`);
  }
  const cur = currentVoice();
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ttsBody(SAMPLE)),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    console.error(`✗ 连不上嗓子服务：${TTS_URL}`);
    console.error('  → 先双击 p1\\start-tts.bat（冷启动 30–60 秒）');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`✗ 合成失败 ${res.status}：${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = path.join(HERE, `voice-test-${cur ? cur.id : 'default'}.wav`);
  fs.writeFileSync(out, buf);
  const secs = (buf.length / 1024 / 64).toFixed(2); // 32kHz mono s16 ≈ 64KB/s
  console.log(`✓ ${cur ? cur.name : '默认'}  ${Math.round(buf.length / 1024)}KB  约 ${secs}s  合成 ${Date.now() - t0}ms`);
  console.log(`  已存 ${out}`);
  if (Number(secs) < 1) {
    console.log('  ⚠ 只有不到 1 秒，几乎肯定是 promptText 和参考音频对不上，用 p2/ear.py --file 核对一下');
  }
}

if (cmd === 'list') show();
else if (cmd === 'use') {
  const v = setVoice(arg);
  if (!v) {
    console.error(`✗ 没有这个音色：${arg || '(空)'}`);
    console.error(`  可用的：${listVoices().map((x) => x.id).join(' / ')}`);
    process.exit(1);
  }
  console.log(`✓ 已切到「${v.name}」（${v.id}）`);
  console.log('  重启 bridge 后生效');
} else if (cmd === 'test') await test(arg);
else {
  console.error(`未知命令：${cmd}`);
  show();
}
