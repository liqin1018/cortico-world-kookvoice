# 第三方组件与许可

本插件（KOOK 语音世界）自身代码采用 **MIT** 许可，见 `LICENSE`。

它依赖以下第三方组件。其中 **ffmpeg 是 GPL v3**，分发时必须保留本文件。

---

## ffmpeg（GPL v3）

| 项 | 内容 |
|---|---|
| 用途 | 语音推流（Opus/RTP 编码）、TTS 输出 wav 转 PCM |
| 版本 | 4.1（`@ffmpeg-installer/win32-x64`，构建配置含 `--enable-gpl --enable-version3`） |
| 许可 | **GNU General Public License v3** |
| 来源 | <https://ffmpeg.org/> · npm 包 <https://www.npmjs.com/package/@ffmpeg-installer/win32-x64> |
| 获取源码 | <https://ffmpeg.org/download.html> · <https://github.com/FFmpeg/FFmpeg> |

**调用方式说明（GPL 合规依据）**：

本插件**不链接** ffmpeg 的代码，而是通过 `child_process.spawn()` 以**独立可执行文件**的方式调用它，
属于 GPL 常见问答中「mere aggregation / 独立进程」的情形，因此不会使本插件代码本身受 GPL 约束。

但**分发 ffmpeg.exe 这个二进制本身**仍需遵守 GPL v3：

- 必须随附本声明与 GPL v3 全文（`LICENSE-ffmpeg.txt`）
- 必须提供获取对应源码的方式（上面已给出链接）
- 不得对 ffmpeg 施加额外限制

> 如果你只想分发自己的代码、不愿意承担 GPL 义务：**不要把 ffmpeg.exe 打进包里**，
> 让用户在首次运行时由 `fetch-env.mjs` 下载（本插件默认就是这个行为）。

GPL v3 全文：<https://www.gnu.org/licenses/gpl-3.0.txt>

---

## SenseVoice（MIT）

| 项 | 内容 |
|---|---|
| 用途 | 中文语音识别（耳朵） |
| 版本 | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` |
| 许可 | **MIT** |
| 来源 | 阿里通义实验室 FunAudioLLM · <https://github.com/FunAudioLLM/SenseVoice> |
| 转换 | 由 k2-fsa 导出为 sherpa-onnx 格式 · <https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models> |

---

## Silero VAD（MIT）

| 项 | 内容 |
|---|---|
| 用途 | 语音端点检测（判断一句话什么时候说完） |
| 文件 | `silero_vad.onnx`（629 KB） |
| 许可 | **MIT** |
| 来源 | <https://github.com/snakers4/silero-vad> |
| 分发镜像 | sherpa-onnx releases（本插件从这里下载） |

---

## sherpa-onnx（Apache-2.0）

| 项 | 内容 |
|---|---|
| 用途 | 语音识别运行时（Python 绑定） |
| 许可 | **Apache License 2.0** |
| 来源 | <https://github.com/k2-fsa/sherpa-onnx> |

---

## Python 依赖

| 包 | 许可 | 用途 |
|---|---|---|
| `soundcard` | BSD-3-Clause | WASAPI 环回 + 麦克风采集 |
| `numpy` | BSD-3-Clause | 音频数组运算 |

完整版本约束见 `engine/p2/requirements.txt`。

---

## 未包含的组件

**GPT-SoVITS（语音合成）不在本插件内**，它由 Coopanion 的「GPTSoVits 语音」扩展单独安装和管理，
其许可与合规责任由那个扩展承担。

---

## 关于 KOOK 协议

- 文字消息、频道列表、语音频道进出：走 KOOK 开放平台 HTTP API
- **语音推流（RTP/Opus）**：KOOK 未公开文档，本插件通过协议分析实现

使用者需自行确认其使用方式符合 KOOK 服务条款。本项目不对因使用本插件导致的账号问题承担责任。
