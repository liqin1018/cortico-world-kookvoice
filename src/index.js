/**
 * 世界定义。框架看到这个对象就知道：叫什么、默认配置是什么、怎么创建实例。
 *
 * 真正的逻辑在 world.js，这里只做声明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KookVoiceWorld } from './world.js';

const DESCRIBE = JSON.parse(
  fs.readFileSync(new URL('../describe.json', import.meta.url), 'utf8'),
);

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 引擎目录。
 * 优先用插件自带的 `engine/`（公开分发时就是这条路），
 * 没有才退回开发机的工作区路径 —— 这样老环境不会被影响到。
 */
const BUNDLED_ENGINE = path.join(SRC_DIR, '..', 'engine');
const DEFAULT_ENGINE_DIR = fs.existsSync(path.join(BUNDLED_ENGINE, 'p1', 'bridge.mjs'))
  ? BUNDLED_ENGINE
  : 'F:/AI/WorkBuddy-workspace/建议Kook桌宠对话插件';

/** 音色选项直接读引擎的 voices.json，不在插件里再抄一份。 */
function voiceOptions() {
  try {
    const p = path.join(DEFAULT_ENGINE_DIR, 'p1', 'voices.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = j.list || [];
    if (list.length) return list.map((v) => ({ value: v.id, label: v.name || v.id }));
  } catch {}
  return [{ value: 'qiong', label: '穹' }];
}

/**
 * 频道列表缓存放在 world.js 里（那边启动时去 KOOK 拉），
 * 这里只把结果递给框架 —— 放 index 里会跟 world.js 循环依赖。
 */

export const KOOKVOICE = {
  id: 'kookvoice',
  label: 'KOOK 语音',

  defaults: () => ({
    // 装了不会自动连，也不会因为重启 Coopanion 就自己进频道 —— 必须主人点「进频道」
    enabled: false,
    // KOOK 机器人令牌。面板上填，存这里（明文，和写 token.txt 一样，别提交到公开仓库）
    kookToken: '',
    // KOOK 服务器 id / 短号 / 名字，由面板「检测」时填入；留空时自动用机器人唯一那台
    guildId: '',
    // 选中的语音频道 id。/ 为空就是还没选 —— 没选不让进频道
    channelId: '',
    // 用哪个音色（voices.json 里的 id 或名字）。ttsSource=plugin 时由那个服务决定，这里不生效
    voiceId: 'qiong',
    // always = 说什么都接；name = 叫名字才接；off = 只听不回
    replyMode: 'always',
    // 唤醒词，逗号分隔。留空 = 自动用她在 Coopanion 里的名字（ctx.botName）
    wakeWords: '',
    // 谁来回答：persona = 交给她本人（Coopanion 主循环，带记忆和上下文）；
    // self = 引擎自己调另一个模型（快，但那不是她）
    answerBy: 'persona',
    // 没有 autoStart —— 进频道只能靠人在面板上点，重启永远不会自己跳进去
    // 嗓子从哪来：plugin = 复用本机已有的语音服务（不重复占显存）；self = 自己拉起一份
    ttsSource: 'plugin',
    // plugin 模式下要连的地址。填你那个语音插件实际用的地址
    ttsUrl: 'http://127.0.0.1:9880/tts',
    // self 模式下嗓子没开时自动拉起来（窗口隐藏）
    autoTts: true,
    // 开耳朵：听频道里的说话声。关掉就只做「文字 → 念出来」
    ears: true,
    // 引擎（bridge.mjs / ear.py）所在目录
    engineDir: DEFAULT_ENGINE_DIR,
    // GPT-SoVITS 自备运行时目录（self 模式才用，必须是 v5-turbo 那套，否则音色会变）
    gsvDir: 'F:/GPT-SOVITS-v5',
    // 推理配置 yaml（self 模式才用）
    ttsConfig: 'F:/Coopanion/data/home/companion/data/gpt-sovits/tts_infer.cuda.yaml',
  }),

  /**
   * 动态下拉的选项表。schema 里写 'x-options': '<kind>'，框架来这里取，
   * 这样中文标签才不会退化成 always / plugin 这种原始值。
   * 未知 kind 返回空数组，框架会继续问别的 World。
   */
  configOptions: (kind) => {
    if (kind === 'answerBy') {
      return [
        { value: 'persona', label: '她本人（Coopanion 主循环，带记忆和上下文）' },
        { value: 'self', label: '引擎自己调模型（快，但那不是她）' },
      ];
    }
    if (kind === 'replyMode') {
      return [
        { value: 'always', label: '说什么都接' },
        { value: 'name', label: '叫名字才接（唤醒词见下一项）' },
        { value: 'off', label: '只听不回' },
      ];
    }
    if (kind === 'ttsSource') {
      return [
        { value: 'plugin', label: '复用本机已有的语音服务（不额外占显存）' },
        { value: 'self', label: '自己拉起一份（9881）' },
      ];
    }
    if (kind === 'voiceId') return voiceOptions();
    return [];
  },

  create: (ctx) => new KookVoiceWorld(ctx),

  describe: DESCRIBE,
};

export { KookVoiceWorld };
export default KOOKVOICE;
