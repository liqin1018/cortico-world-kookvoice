# 环境清单（一键下载的数据来源）

这份文件是 `p2/fetch-env.mjs` 的唯一数据源。想换模型、加镜像，改这里，不用动代码。

## 落地路径规则

**生产环境**：所有大文件下到 Coopanion 的用户数据目录，
形如 `<data>/kookvoice/{bin,models}/` —— 重装插件不会丢。

**开发环境**（没传 `COO_DATA_DIR`）：沿用引擎内的 `p0/bin` 和 `p2/models`。

## 模型

### 1. SenseVoice 语音识别（必需）

| 项 | 值 |
|---|---|
| URL | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2` |
| 压缩包大小 | 163,002,883 字节（约 156 MB） |
| 解压后 | 约 229 MB |
| 落地路径 | `<data>/kookvoice/models/sense-voice/{model.int8.onnx,tokens.txt}` |
| 许可 | 见包内 LICENSE |

**为什么选 int8 专用包而不是完整包**：
完整包 `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2` 是 **1047 MB**
（里面 895 MB 是 fp32 模型），我们只用 int8 的 229 MB，没必要下、也没必要存。

**校验值**（解压后逐个文件核对，官方没提供包级 SHA256）：

```
c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51  sense-voice/model.int8.onnx
f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc  sense-voice/tokens.txt
```

### 2. Silero VAD（必需，629 KB）

| 项 | 值 |
|---|---|
| URL | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx` |
| 大小 | 629 KB |
| 落地路径 | `<data>/kookvoice/models/vad/silero_vad.onnx` |

**校验值**：

```
9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6  vad/silero_vad.onnx
```

备用地址（上面那个挂了再用）：
`https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx`

## Python 依赖

见 `p2/requirements.txt`：

```
sherpa-onnx>=2.0.1,<3
soundcard>=0.4.6,<0.5
numpy>=1.24
```

实测环境：Python 3.13.12 / sherpa-onnx 2.0.1 / soundcard 0.4.6 / numpy 2.5.4。

**sherpa-onnx 别跨大版本**：1.x 和 2.x 的 `OfflineRecognizer` / `VoiceActivityDetector`
构造参数有变化，升级前先跑 `p2/ear.py --file <wav>` 验证。

## Node

**不需要用户单独安装。**

Coopanion 的 Electron 可以直接当 Node 用（实测 v24.21.0）：

```bash
ELECTRON_RUN_AS_NODE=1 "<Coopanion 安装目录>/Coopanion.exe" -e "console.log(process.version)"
```

`world.js` 的 `findNode()` 按这个顺序找：
1. 环境变量 `COO_NODE`
2. `ELECTRON_RUN_AS_NODE=1` + Coopanion.exe
3. 系统 PATH 里的 `node`

## ffmpeg（GPL v3）

**需要下载**（163→62 MB）。

| 项 | 值 |
|---|---|
| URL | `https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-4.1.0.tgz` |
| 大小 | 62 MB |
| 落地路径 | `<data>/kookvoice/bin/ffmpeg.exe` |
| 许可 | **GPL v3**（分发须附 THIRD-PARTY.md） |

校验值：

```
c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e  ffmpeg.exe
```

## 嗓子（GPT-SoVITS，10 GB+）

**不在这份清单里**，走 Coopanion 的「GPTSoVits 语音」插件 —— 它自己有下载和版本管理，
比我们再抄一套靠谱。装好之后把「嗓子从哪来」设成「复用本机已有的语音服务」即可。

---

## 磁盘占用估算

| 项 | 大小 |
|---|---|
| 引擎代码（p0+p1+p2 不含模型） | 约 67 MB（其中 ffmpeg 62 MB） |
| 模型 | 230 MB |
| **合计** | **约 300 MB** |

嗓子另算（10 GB+，由 GPTSoVits 插件管理）。
