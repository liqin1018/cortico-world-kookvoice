// KOOK OpenAPI 极简封装 —— 只依赖 Node 内置 fetch，无需 npm 安装
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE = 'https://www.kookapp.cn/api/v3';

/** 读取 Bot Token：优先环境变量 KOOK_TOKEN，其次同目录 token.txt
 *  逐行扫描，跳过空行、# 注释行和占位符；顺手去掉可能被带上的引号 */
export function loadToken() {
  const env = process.env.KOOK_TOKEN;
  if (env && env.trim()) return env.trim();

  const f = path.join(HERE, 'token.txt');
  if (fs.existsSync(f)) {
    const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim().replace(/^["'`]|["'`]$/g, '').trim();
      if (!s) continue;
      if (s.startsWith('#') || s.startsWith('//')) continue;
      if (s.includes('把这里') || s.includes('粘贴')) continue;
      return s;
    }
  }

  throw new Error(
    [
      `token.txt 里没有找到 Token（文件里只有注释或空行）。`,
      `  路径：${f}`,
      '  做法：用记事本打开它，在最下面新加一行，把 Token 粘进去，保存。',
      '  或者设置环境变量 KOOK_TOKEN=<token>',
    ].join('\n'),
  );
}

/** 统一请求：自动带上 Bot 认证头，非 0 code 抛错 */
export async function api(method, route, { token, query, body } = {}) {
  const url = new URL(BASE + route);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} 返回了非 JSON 内容：${text.slice(0, 300)}`);
  }

  if (json.code !== 0) {
    const err = new Error(`KOOK 接口报错 code=${json.code} message=${json.message || '(无)'}`);
    err.code = json.code;
    err.raw = json;
    throw err;
  }
  return json.data;
}

/** KOOK 里语音频道的 type 是 2，文字频道是 1 */
export const CHANNEL_TYPE = { TEXT: 1, VOICE: 2, CATEGORY: 3 };

export function channelKind(type) {
  if (type === CHANNEL_TYPE.TEXT) return '文字';
  if (type === CHANNEL_TYPE.VOICE) return '语音';
  if (type === CHANNEL_TYPE.CATEGORY) return '分组';
  return `type${type}`;
}
