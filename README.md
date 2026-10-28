# OSR6 联动

通过 TCode 协议驱动 OSR6 / SR6 等外设（UDP 或 USB 串口），并支持把 funscript 时间轴播到某个轴上。

## 目录结构

```
extension.json      扩展清单（entry = dist/index.mjs，studioEntry = dist/studio.js）
ui/                 引擎托管的界面文档（设置页 + 4 个输入对话框）
src/
  index.tsx        扩展入口：项目设置 + 全部剧本方法
  studio.tsx       编辑器设置页：funscript → WAV 载波导入
  tcode.ts         TCode 编码（轴表、幅值、DSTOP）
  transport.ts     传输层：node:dgram（UDP）/ Web Serial（串口）
  engine.ts        设备引擎：目标值、平滑、固定频率下发、急停
  funscript.ts     funscript 解析与采样（纯函数）
  player.ts        播放时钟：play/pause/resume/seek/stop、循环、倍速
  script-store.ts  指针解析（asset / var / global / 内联）+ 素材缓存
  carrier.ts       WAV 载波编解码（LGF1 + CRC32）
tools/
  pack-funscript.mjs  CLI：把 .funscript 打包成 WAV 载波
  carrier.mjs         由 carrier.ts 打包生成（npm run pack:build）
scripts/watch.mjs     两趟构建的 watch 模式
```

## 设备

- UDP：OSR6 连接同一 WiFi 后监听端口 8000（可在设置里改地址与端口）。
- 串口：走 Chromium 的 Web Serial，需要宿主允许访问串口；不可用时请改用 UDP。

## 指针（仅供内部解析用）

正式流程是「素材 + 播放脚本」，用户不需要接触指针。指针只保留给内部的
`解析 funscript`（隐藏方法，不进 Studio 的方法选择器）：

| 指针写法 | 含义 |
|---|---|
| `asset:se/xxx.wav` | **正式来源**：读项目素材里的 WAV 载波（见下一节） |
| `var:变量名` | 从项目变量读取。变量值可以是 JSON 文本，也可以是已解析的对象 |
| `global:键名` | 从 `globalThis.__osr6Scripts` 读取（普通对象或 Map） |
| `{` / `[` 开头 | 直接当作内联 JSON 解析（测试、短脚本） |
| 其他裸名字 | 兜底再去 `globalThis.__osr6Scripts` 找一次 |

外部加载代码只需要做一件事：

```js
globalThis.__osr6Scripts = globalThis.__osr6Scripts || {};
globalThis.__osr6Scripts.fight01 = funscriptJsonText;
```

变量与全局表由各自的持有者负责生命周期；扩展侧不再维护内存登记表。

## WAV 载波（funscript 的正式存放方式）

Studio 的素材管线**不接受 `.funscript`**：11 个资产分类都不含这个类型，改名成
`.json` 会被白名单拒绝，`assets/dynamic/` 只接受真正的 Spine/Live2D 模型。
但 Studio 接受 `assets/se/*.wav`，并且导入是**逐字节原样拷贝**（实测 SHA-256 不变）。

所以 funscript 被打包进一个 8-bit PCM 的 WAV：`data` 块里是带校验的原文。
运行时扩展 `fetch` 这个素材、跳过 WAV 头、校验 CRC、解出文本再播放。

### 打包

```bash
npm run pack -- "D:/脚本/fight01.funscript"          # 同目录生成 fight01.wav
npm run pack -- "D:/脚本/fight01.funscript" out.wav  # 指定输出
```

工具会先校验 JSON 和 actions，再打包、立刻解一遍自检（内容和原文不一致就报错）。

### 在 Studio 里使用

1. 把生成的 `.wav` 导入 `assets/se/`
2. 选中它，把打包策略改成**强制打包** —— 未被引用的素材默认 `willPack: false`，
   不设这一步，开发时正常、打包后素材会消失
3. 剧本里用 `播放脚本` 选中它（脚本组的一行 = 轴 + 素材 + 强度范围）

### 载体格式

```
WAV: RIFF/WAVE, PCM 8-bit, 单声道, 44100Hz
data 块：
  0   4  魔数 "LGF1"
  4   1  版本（当前 1）
  5   1  标志，保留
  6   4  payload 字节数（uint32 LE）
  10  4  payload 的 CRC32（uint32 LE）
  14  N  UTF-8 的 funscript JSON
```

解析按块遍历（不假设 44 字节头），CRC 不匹配时报「文件在打包后被改动过」。
100 KB 的脚本约等于 2.3 秒的 8-bit 单声道音频，对素材管线没有负担。

## 编辑器设置页：一键导入 funscript

Studio 支持扩展自带编辑器页面（`studioEntry` + `@avg-studio/studio-ui`），这里用它做了
「选 .funscript → 打包成 WAV → 写进项目 assets/」的按钮，省掉手动跑 `npm run pack`。

页面行为：

1. 点「选择 .funscript」，选中后显示动作点数、时长、生成的 WAV 大小
2. 点「打包并写入资产目录」，写到 `<项目目录>/assets/<输出目录>/<名字>.wav`
3. 输出目录由设置 `osr6.scriptImportFolder` 决定（默认 `bgm`），
   同名文件默认自动加 `-2`、`-3`，可用 `osr6.scriptImportOverwrite` 改成覆盖

写完仍需要在 Studio 里**刷新资产**（Studio 不会自动扫描新文件），并把该素材的
打包策略设为**强制打包**，否则不会进构建。

### 设备面板：只配参数，不占设备

编辑器**不建立设备连接**。之前的版本在设置页里真的连过一次，结果是编辑器和预览
各持有一条连接、互相抢位置——没有意义，所以去掉了。

现在「设备连接」区块只做两件事：

| 控件 | 行为 |
|---|---|
| 连接方式 | 写项目设置 `osr6.transport`（UDP / 串口），运行时读的是同一个字段 |
| 测试设备 | 发一条 `D0`（询问设备身份），等最多 1.2 秒，显示设备回复或「没有响应」 |
| 串口（仅串口模式） | 列出**已授权**的串口，点一下写入 `osr6.serialPortIndex`；「添加串口…」打开系统对话框授权新端口 |

关于串口选择：Web Serial 没有「枚举全部 COM 口」的接口，只能看到用户授权过的端口。
所以列表来自 `getPorts()`，序号就是设置里存的 `serialPortIndex`，运行时的连接和这里的
测试用的是同一个序号。同一台机器插多个同型号适配器时序号可能变，想稳定就用
`osr6.serialVendorId` / `osr6.serialProductId` 过滤。

两种传输的测试方式不同：

- **UDP**：只发一个数据包，不建立会话、不占用设备。
- **串口**：TCode 的串口是双向的（`D0` 回设备与固件版本、`D1` 回协议版本、`D2` 回轴列表），
  所以测试会**短暂打开端口 → 发 `D0` → 读回包 → 立刻关闭**。打开期间设备被占用，
  所以不要和预览同时进行；这也顺带验证了波特率和接线。

串口测试依赖 `navigator.serial`（Web Serial）。如果 Studio 窗口没有开这个能力，
按钮会明确提示「这个窗口没有 Web Serial」，此时只能改用 UDP 或在预览里连接。

地址、端口、波特率、USB ID 都在「其他设置」里改，运行时和预览读同一份配置。
真正的连接只发生在预览/游戏运行时。

### 实现说明（重要取舍）

- 项目目录来自宿主注入的 `globalThis.__avgVisualUIProjectDir__`，实测就是工程根目录。
- 写文件用的是宿主窗口里的 Node `require("fs")`。**官方文档不建议在编辑期入口用
  Node**：工坊审核会因此把扩展标记为特权、需要人工过审。这是本地扩展的取舍——
  编辑器页面没有「导入素材」的接口，不碰 `fs` 就无法把转换结果放进资产目录。
- 编辑期入口 `src/studio.tsx` 只给 Studio 加载，游戏运行时不加载它。

## 玩家侧：扩展自带的设置界面

玩家改设备地址靠一组随扩展发布的界面文档；扩展**不再实现 `render()`**，没有 React 原生界面。

### 界面文档

`ui/` 目录下的界面文档会注册成扩展界面：

| 文档 | 说明 |
|---|---|
| `ui/osr6-settings.json` → `@com.httdesu.osr6-bridge/osr6-settings` | 唯一界面：内嵌地址输入对话框（写项目变量 `OSR6设备地址`）+ 连接方式按钮 + 测试 / 关闭 |

界面结构：顶部两个模式按钮（用 UDP / 用串口）直接调用 `设置连接方式`，方法写变量后
面板按 `OSR6连接方式` 显隐；每行数值后面有一个 ✎ 图标，点开对应输入对话框。
没有"启用连接"按钮——停在哪个面板就用哪种连接方式。
也可以从任意 UI 按钮用 `ui.open` 指向 `osr6-settings`。

界面采用深色主题（背景 `#0b1219`、青色强调 `#5fbbae`/`#7fd4c8`），和引擎原生的输入对话框统一色调：
卡片里是三行只读值（连接方式 / 设备地址 / 设备端口），右侧两个按钮打开独立的输入对话框。

四个输入对话框（地址 / 端口 / 串口序号 / 波特率）**全部使用 string 类型**，因此外观完全一致；
对应的项目变量也都是字符串，扩展侧用 `toNumber()` 解析，非法值回落到作者的扩展设置。

### 存储与自动重连

- 玩家改的值存在项目变量 `OSR6设备地址` / `OSR6设备端口`（`persistence: shared`，跨存档）
- 读取优先级：玩家变量 → 作者的扩展设置
- 扩展每 2 秒检查一次这两个变量，**变了就自动用新地址重连**，所以改完不用重启游戏


## 方法

`连接 OSR6`、`断开 OSR6`、`急停`、`回到中位`、`设置轴位置`、`读取连接状态`、
`播放脚本`、`设置播放速度`、`设置强度范围`、`暂停脚本`、`继续脚本`、`跳转脚本`、`停止脚本`、
`读取脚本播放状态`。

另有隐藏方法 `解析 funscript`：只解析不播放，供内部与调试使用，不出现在
Studio 的方法选择器里（已写进剧本的调用照常执行）。

## 播放脚本

播放接口是**组**的形式：一次调用可以同时驱动多个轴，每个轴一条脚本；
只有一条脚本时就传长度 1 的数组。

- 组内每个轴一个独立的播放器，同时开播，共享开始时刻
- 同一个轴在一次调用里出现两次会报错（请合并成一条）
- `暂停脚本` / `继续脚本` / `跳转脚本` / `停止脚本` / `读取脚本播放状态` 都作用于整组
- 倍速不在播放参数里：用 `设置播放速度` 单独调，播放中立即生效且不跳进度，没在播放时记下来给下次用

素材仍然是 WAV 载波（见上一节）。每一行只有两个参数：

| 参数 | 说明 |
|---|---|
| 轴 | 这一行驱动哪个轴（L0–A2） |
| 脚本素材 | WAV 载波（audio 素材） |

强度不在播放参数里，由 `设置强度范围` 单独设置（同样是列表输入，按轴生效）：

| 参数 | 范围 | 默认 |
|---|---|---|
| 轴 | L0–A2 | L0 |
| 强度下限（%） | 0–100 | 0 |
| 强度上限（%） | 0–100 | 100 |

输出按 `下限 + (上限 - 下限) × 脚本值` 线性重映射，播放中改会立即生效，所以：

- `0–100`：原样播放
- `0–40`：整体压到四成幅度（浅一些）
- `40–100`：把整段抬到 40%–100%（只在上半区活动）
- `100–0`：反向（等价于「输出反相」）
- 上下限相同：整段保持恒定强度

## 开发

```bash
npm install
npm run build          # 两趟构建：dist/index.mjs + dist/studio.js
npm run watch          # 同时监听两个入口
npx tsc --noEmit
npm run pack -- <file.funscript>   # 命令行打包（CI / harness 用）
```