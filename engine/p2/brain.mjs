// 大脑：复用 Coopanion 已配置的服务商，流式出字并立刻切成句子
//
// 为什么要切句：整段等完再合成，延迟 = 生成全文 + TTS；边生成边合成，
// 第一句话的 TTS 可以和后面的生成重叠，体感快 1 秒以上。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROOT = 'F:\\Coopanion\\data\\home\\providers';

/** 读服务商配置与密钥（密钥只在本进程内使用，不落日志） */
export function loadProvider(name, root = DEFAULT_ROOT) {
  const dir = path.join(root, name);
  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) throw new Error(`找不到服务商配置：${cfgPath}`);

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
  const envPath = path.join(dir, '.env');
  const env = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_0-9]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const key = env[cfg.secret] || Object.values(env)[0];
  if (!key) throw new Error(`${name} 里没有读到密钥`);

  return {
    baseUrl: String(cfg.baseUrl || '').replace(/\/+$/, ''),
    key,
    model: cfg.spec?.model,
    temperature: cfg.spec?.temperature,
    maxTokens: cfg.spec?.maxTokens,
  };
}

const SENTENCE_END = /[。！？!?；;\n]/;

/**
 * 去掉舞台指示。
 * 人格设定里允许写「（把黑助往怀里拉了拉）」这种括号动作，文字聊天没问题，
 * 但这里是语音 —— TTS 会把它一个字一个字念出来，听起来像精神分裂。
 */
function stripStage(text) {
  return String(text)
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 念出来之前的清理。
 * 穹说话爱用省略号开头（「……不说。」），TTS 会把开头那一截气流也合进去，
 * 4 个字只出 0.47 秒音频，听起来就是「哼」一声。前导标点全部剥掉。
 */
function tidy(text) {
  return stripStage(text)
    .replace(/^[\s…⋯.·、，,。！？!?；;~～—－-]+/, '')
    .replace(/[\s…]+$/, '')
    .trim();
}

/** 有效字数（不含标点），用来判断这句话值不值得单独合成一次 */
function effLen(s) {
  return s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').length;
}

/** 少于这个字数就不单独念了，攒着和下一句一起说 */
const MIN_SPEAK_CHARS = 5;

/** 读 Coopanion 的人格设定（workspace/CONSTITUTION.md）。读不到就退回内置的简版。 */
function loadPersonaText(file) {
  if (!file) return '';
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    return t ? `\n\n===== 你的人格设定（这是「你是谁」，必须完全遵守，高于上面所有规则）=====\n\n${t}` : '';
  } catch (e) {
    console.log?.(`  (人设读不到：${file} —— ${e?.message ?? e}，先用内置的)`.trim());
    return '';
  }
}

export class Brain {
  constructor({ provider = 'infistar', providersRoot, model, temperature, maxTokens, systemPrompt, fallbackModel, firstTokenTimeoutMs, disableThinking, personaFile } = {}) {
    const p = loadProvider(provider, providersRoot);
    this.baseUrl = p.baseUrl;
    this.key = p.key;
    this.model = model || p.model || 'deepseek-flash';
    // 推理模型（glm-5.3-flash / deepseek 默认）会先把 token 烧在 reasoning_content 上，
    // max_tokens 一截断 content 就是空的 —— 表现为「等很久，然后她没声了」。
    // apigoto 的 deepseek-flash 实测 thinking:disabled 后 reasoning=0、首字 657ms。
    this.disableThinking = disableThinking ?? false;
    this.fallbackModel = fallbackModel || null;
    this.firstTokenTimeoutMs = firstTokenTimeoutMs ?? 5000;
    this.temperature = temperature ?? 0.85;
    this.maxTokens = maxTokens ?? 200;
    // 这里只写「语音场景」的规矩（怎么说话、别念出 markdown），
    // 「你是谁」交给 personaFile（Coopanion 的 CONSTITUTION.md）。
    // 曾经把「第一句必须 5~12 字」也写在这儿，结果她说话变得像客服复读机。
    const basePrompt =
      systemPrompt ||
      [
        '你现在在 KOOK 的语音频道里，用嘴和大家说话 —— 你的话会被合成成声音念出来。',
        '',
        '1. 只输出要说出口的字。不要 markdown、星号、括号里的动作描写、表情符号。',
        '2. 一次 1~3 句，像真的在聊天，别长篇大论。',
        '3. 永远用简体中文。哪怕收到的文字像外语、假名或者乱码，也用中文回。',
        '4. 听不清就问一句「啊？我没听清」，不要瞎猜。',
        '5. 不要提自己是 AI 或模型。',
      ].join('\n');
    const persona = loadPersonaText(personaFile);
    this.systemPrompt = persona ? `${basePrompt}${persona}` : basePrompt;
    this.history = [];
    // 12 条（6 轮）时首句能拖到 30 秒 —— prompt 越长模型越慢，而语音对话根本用不上那么长的记忆。
    this.maxHistory = 8;
  }

  /** 流式生成，边生成边吐出「说完整的句子」，调用方可以马上送去合成 */
  async *streamReply(userText) {
    this.history.push({ role: 'user', content: userText });
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);

    // 主模型抽风（首字超时/5xx）时自动换备用模型再来一次。
    // 只在前半句一个字都没吐出去时重试 —— 已经说过话就不能重来。
    const models = [this.model, this.fallbackModel].filter(Boolean);
    let lastErr = null;
    for (let i = 0; i < models.length; i++) {
      const isLast = i === models.length - 1;
      try {
        yield* this._streamWith(models[i], isLast ? 0 : this.firstTokenTimeoutMs);
        return;
      } catch (e) {
        lastErr = e;
        if (!e.retryable) throw e;
        if (!isLast) console.log?.(`  (${models[i]} 超时，换 ${models[i + 1]} 重试)`);
      }
    }
    throw lastErr || new Error('大脑没有可用模型');
  }

  async *_streamWith(model, firstTokenTimeoutMs) {
    const body = {
      model,
      messages: [{ role: 'system', content: this.systemPrompt }, ...this.history],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
      ...(this.disableThinking ? { thinking: { type: 'disabled' } } : {}),
    };

    const ctrl = new AbortController();
    let emitted = false;
    let timer = null;
    if (firstTokenTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (!emitted) ctrl.abort();
      }, firstTokenTimeoutMs);
    }

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`LLM ${res.status}: ${text.slice(0, 160)}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let full = '';
      let pending = '';
      let carry = ''; // 攒着的短句
      let finishReason = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let j;
          try {
            j = JSON.parse(payload);
          } catch {
            continue;
          }
          finishReason = j.choices?.[0]?.finish_reason || finishReason;
          const delta = j.choices?.[0]?.delta?.content || '';
          if (!delta) continue;
          if (!emitted) clearTimeout(timer); // 首字到了，不用再盯着超时
          full += delta;
          pending += delta;
          // 一句说完就吐出去，不用等全文
          let m;
          while ((m = pending.match(SENTENCE_END))) {
            const cut = m.index + 1;
            const raw = pending.slice(0, cut);
            pending = pending.slice(cut);
            const clean = tidy(raw);
            if (!clean) continue;
            const merged = carry + clean;
            // 太短就先别念 —— 单念一句「不说」只有半秒，听感上是「哼」一下
            if (effLen(merged) < MIN_SPEAK_CHARS && merged.length < 40) {
              carry = merged;
              continue;
            }
            carry = '';
            emitted = true;
            yield merged;
          }
        }
      }

      // 收尾：把攒着的短句和剩下的尾巴一起说完
      const tail = carry + tidy(pending);
      if (effLen(tail) > 0) {
        emitted = true;
        yield tail;
      }

      // content 为空时说明 token 全烧在 reasoning 上了，明确报出来，
      // 否则上层只会看到「生成中……然后没了」
      if (!full.trim()) {
        const err = new Error(
          finishReason === 'length'
            ? `模型把 token 全用在思考上了（${model}，max_tokens=${this.maxTokens}），把 maxTokens 调大或换成非推理模型`
            : `模型返回空内容（${model}）`,
        );
        err.retryable = true;
        throw err;
      }

      this.history.push({ role: 'assistant', content: full.trim() });
      if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    } catch (e) {
      // 还没开口就失败 → 允许上层换模型重试
      if (!emitted) e.retryable = true;
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  reset() {
    this.history = [];
  }
}
