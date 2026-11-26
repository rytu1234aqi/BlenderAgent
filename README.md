# BlendGuard（模鉴）

BlendGuard 是一个面向已有 Blender 硬表面工程的可信局部编辑原型。一个 Planning Agent 把自然语言转换为受限编辑意图，宿主程序生成编辑契约和类型化工具计划，Blender Runner 在工作副本中执行；只有目标、非目标局部性和可选 GLB 检查全部通过才提交。

机柜是 ICT 教学演示案例，不是能力边界。当前受控工具仍以结构明确的 Mesh、Curve 和父子装配为范围，不支持任意自由建模。

使用文档：

- [Agent 与 Web 使用示例](examples/agent_demo.md)
- [Web 工作台说明](web/README.md)

## 当前已实现

### 确定性执行核心

- 编辑契约、操作模型、稳定错误代码和确定性对象／材质 ID；
- Scene IR 使用 `foreach_get` 批量读取网格顶点、边、面与环并计算二进制几何指纹。检查还覆盖 UV、颜色属性、形态键、材质节点与连线、部分约束和动画关键帧。66,049 顶点的网格两次提取耗时 **0.129 s** 和 **0.124 s**。 [网格测试日志](runs/deepseek_e2e_suite/regression/final_geometry_benchmark.log)
- 原文件哈希、只读留存副本、工作副本、逐步检查点和验证后提交；
- 8 个真实 `bpy` 工具：创建长方体、移动、旋转、设置尺寸、复制、材质、倒角和 Curve 端点；
- 异常恢复后重新提取 Scene IR，证明恢复状态与初始状态一致；
- GLB 导出、Curve 仅在内存转 Mesh、再导入检查；
- `blendguard verify` 在新进程中重新计算源／输出哈希、目标、局部性和 GLB。

### 可识别教学资产

- 144 个对象的原创程序化机柜：框架、四块层板、4 台服务器、硬盘位、接口、状态灯、交换机和两条可见线缆；
- 服务器子对象随主体移动，端口用 Empty 明确定位；
- `asset_manifest.json` 声明 `protected_objects`、Web 预览的 `previews.directory` 与 `previews.views`、1U、相机和初始线缆连接。教学资产保护 `rack` 和 `demo_floor`；
- 总览、正面、右侧和线缆特写四个固定相机；
- 预览渲染不保存场景、不修改源文件。

生成资产与预览：

```powershell
D:\Blender\blender.exe --background --factory-startup --disable-autoexec --python examples\teaching_rack.py -- E:\code\BlenderAgent\assets\teaching_rack.blend
```

```powershell
$env:PYTHONPATH = "src"; python -m blendguard preview --source assets\teaching_rack.blend --output-dir assets\previews --blender D:\Blender\blender.exe
```

### 受控 Planning Agent

- 精简场景摘要只向规划器提供对象 ID、名称、变换、尺寸、材质和连接等必要信息，不发送完整顶点表；
- 默认使用 DeepSeek JSON Output 结构化规划适配器，不声明任意代码执行工具；Claude 适配器作为显式可选提供方保留；
- 明确标注的离线教学解析器，用于无凭据环境端到端测试，不冒充大语言模型；
- 模型只返回一个编辑意图，宿主负责目标解析、单位换算、契约、写集、约束和工具参数；
- 支持移动、局部轴旋转 `rotate_part`、在指定世界坐标创建长方体 `create_box`、设置尺寸、装配复制、倒角和已有材质槽分配。移动或旋转已连接部件时自动更新声明的 Curve 端点；
- 装配复制显式登记每个 Mesh／Empty 后代，保留父子关系并共享网格数据，每个新对象都必须在写集中；
- 目标不唯一返回 `TARGET_AMBIGUOUS`，置信度低于 `0.85` 返回 `CONFIRMATION_REQUIRED`；
- 默认只生成计划，必须显式传入 `--execute` 才调用 Runner；
- `--plan-input` 重新读取同一份已审阅计划；低置信度批准和目标确认必须绑定该文件，源哈希、场景摘要、指令或意图变化都会拒绝执行；
- 最多两次有界重试；每次使用独立尝试目录，不允许重试扩大契约或改变目标；
- 非目标差异、权限失败、源哈希变化和导出失败不会自动重试；
- 只有成功尝试进入根运行目录的 `delivery/`，模型没有宣布验证通过的权限；
- 每个主机启动的 Blender 进程默认有 300 秒超时，可用 `--blender-timeout` 调整；
- 场景检查只读取源工程目录内的外部图像，目录外路径仅记录为未读取并列入覆盖说明。
- 规划只读检查使用内容寻址缓存。缓存按源 SHA-256、源路径、Blender 可执行文件标识和提取器版本定位，命中时校验 Scene IR 摘要与源目录内图像。教学机柜检查从 **1,289.68 ms** 降到 **14.89 ms（86.64×）**，场景摘要 SHA-256 一致。Runner 与独立 Verifier 在各自 Blender 进程中重新提取场景。 [缓存实测](runs/deepseek_e2e_suite/cache_benchmark/summary.json)

### 本地 Web 可信编辑工作台

- React / Three.js 三栏工作台，分离源资产固定预览和已验证交互式 GLB；
- 自然语言只生成计划，页面展示完整契约、写集、派生规则、约束、工具参数和当前 SHA-256；
- 目标／低置信度确认只解析同一计划，确认后仍需完整审阅并单独点击执行；
- 受控 Express HTTP / SSE 适配层复用现有 Python CLI，不包含上游 DeepSeek 自由工具循环、Blender MCP 或自由 `execute_python`；
- Runner `COMMITTED` 后自动调用新进程独立复验，只有 `VERIFIED` 才发布工程、GLB 和质量报告；
- 历史运行从磁盘机器报告重建，已完成计划不能重复执行；
- 本机回环监听、Host / Origin 检查、固定资产与产物映射、子进程输出上限和单忙任务控制。

启动方式见 [Web 工作台说明](web/README.md)。

## 任务 5：真实 DeepSeek 云端 E2E

六个正向用例均通过 `READY → COMMITTED → VERIFIED`，三个边界用例均在规划门禁结束（含此前的 `move_part` 云端验收共完成全动作实测）。本次共发起 11 次真实规划请求，含材质导出修复和歧义提示词澄清后的两次重跑。

| 用例 | request_id | 模型 | 规划文件 SHA-256 | 状态 | 未授权差异 | 源 SHA-256 | 证据 |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| set_dimensions | `491c148c-c409-4404-a693-254ea6690d9e` | `deepseek-flash` | `49fecd0fc6322679ade0a2c07b43a4318c08be362d778d72cb6da1aac01a63b4` | `VERIFIED` | 0 | 一致 | [证据](runs/deepseek_e2e_suite/01_set_dimensions/attempt_01/run/reports/independent_verification.json) |
| duplicate_part | `65044c09-fa7b-4b8a-9829-4be05686449e` | `deepseek-flash` | `6b2832526732156d4f331b316082f0d83cf3b7564817dd46b5483a6fcbb0e311` | `VERIFIED` | 0 | 一致 | [证据](runs/deepseek_e2e_suite/02_duplicate_part/attempt_01/run/reports/independent_verification.json) |
| add_bevel | `defebb53-a638-4987-b887-0123804b6d99` | `deepseek-flash` | `5d507bea7f725779a031ac85efa14011bf55500b13e2a3593b9bf552dd02fd06` | `VERIFIED` | 0 | 一致 | [证据](runs/deepseek_e2e_suite/03_add_bevel/attempt_01/run/reports/independent_verification.json) |
| assign_material | `cbe6c3c5-ebe0-4977-8e22-371ba2b22b68` | `deepseek-flash` | `6184c157785ac24ecefdb03c3adb7962bac062030676cf9bd17fb6035beae29f` | `VERIFIED` | 0 | 一致 | [证据](runs/deepseek_e2e_suite/04_assign_material/attempt_02/run/reports/independent_verification.json) |
| rotate_part | `354a68d3-abcf-45fc-a4e5-9b42e50da74d` | `deepseek-flash` | `b155a8993383af6333123063162bdb8023b4a8fc2c19ac7ee7b66c808ba0470c` | `VERIFIED` | 0 | 一致 | [证据](runs/deepseek_e2e_suite/05_rotate_part/attempt_01/run/reports/independent_verification.json) |
| create_box | `6de0d9b9-d638-4fd3-9556-2e0ccf9e9d57` | `deepseek-flash` | `312b38e6eb916673ce4310c7d3474c2f9755d24fa2b3124ea1bc039ec1d46ff0` | `VERIFIED` | 0 | 一致 | [证据](runs/deepseek_e2e_suite/06_create_box/attempt_01/run/reports/independent_verification.json) |
| ambiguous_target | `fb5e2e93-1daa-4bd4-9ed4-9bbfa1ed76f4` | `deepseek-flash` | `67bbbe540c3a2696320d51b28d65f09bc2c79175b530ba00eee9f8dd73957b61` | `NEEDS_CONFIRMATION` | 0¹ | 一致 | [证据](runs/deepseek_e2e_suite/07_ambiguous_target/attempt_02/reviewed.plan.json) |
| protected_object | `b31afc23-9d33-4c7e-bc35-8f7a7c04ec16` | `deepseek-flash` | `a064b5f50069948d4b93a2f568030f152de44ff3a3c4e102c97358bfc46f7b8b` | `NOT_EXECUTABLE` | 0¹ | 一致 | [证据](runs/deepseek_e2e_suite/08_protected_object/attempt_01/reviewed.plan.json) |
| unsupported | `4e861f45-5a04-4b90-b8c5-8ce7faac21ce` | `deepseek-flash` | `ddf0c2ad5a237f16f4e903fa66b2255b77d25f37187c6a470997cd424e0f6ed1` | `NOT_EXECUTABLE` | 0¹ | 一致 | [证据](runs/deepseek_e2e_suite/09_unsupported/attempt_01/reviewed.plan.json) |

¹ 边界用例只规划，运行目录均未创建。0 表示未发生执行改动，边界用例无执行差异报告。

九个用例及两次重跑的源 SHA-256 均为 `7dd02d6dd29ecb6cc08239f334bf5a3c53ad35de25aac7e65d6ae85099e295bb`，与当前源文件一致。表中计划 SHA-256 来自执行前的原始计划文件。六个正向用例的 `approved_plan_sha256` 与对应表值逐一匹配。

## 明确尚未实现或验证

- AgentArts 和多人协作尚未实现；Web 工作台是本机单用户、单忙任务产品，不提供任意工程上传或源文件删除。
- 任意网格生成、自由 `bpy`、复杂几何节点、Bezier 端点编辑、自动视觉语义反馈不在当前范围。
- Scene IR 不是完整 `.blend` 的无损替代；报告会列出未覆盖项，局部性通过不等于整个文件绝对不变。
- 离线解析器只覆盖文档中的教学句式，不是通用中文自然语言理解器。
- Blender 子进程有超时控制，但尚未实现通用内存上限；Web 适配层另有 1,000,000 字符输出上限。整个运行目录持续不可写等环境级故障也无法保证生成报告。

## 环境

- 主机 Python 3.11 或更新版本；
- Blender 4.4.3（当前验证版本，内置 Python 3.11.11）；
- 核心和离线规划器没有第三方主机运行时依赖；真实 DeepSeek 适配器需要可选 `openai` SDK 和用户自己的 `DEEPSEEK_API_KEY`；
- Web 工作台需要 Node.js 20 或更新版本；本次使用 Node.js 24.12.0、npm 11.6.2；
- 可选 Claude 适配器需要 `[claude]` extra 中的 `anthropic` SDK 和用户自己的凭据。

安装核心命令：

```powershell
python -m pip install -e .
```

安装默认 DeepSeek 模型适配器（`agent` 与 `deepseek` extra 等价）：

```powershell
python -m pip install -e ".[deepseek]"
```

也可以不安装项目，在 PowerShell 中设置 `$env:PYTHONPATH = "src"` 后使用 `python -m blendguard`。真实 DeepSeek 调用仍需安装 OpenAI 兼容 SDK。

Blender 不在 PATH 时，通过 `--blender D:\Blender\blender.exe` 指定，或设置 `BLENDER_EXECUTABLE`。首版建议固定 Blender 4.4.3，避免基准运行中混用版本。

## 运行测试

当前最终回归通过 Python／Blender **98 / 98（142.120 s）**、Web 后端 **27 / 27（2.175 s）**、Playwright **3 / 3（16.6 s）** 和真实 HTTP／Blender **1 / 1（35.200 s）**，均无跳过。TypeScript 检查通过，Vite 在 **7.16 s** 生成 **817.65 kB** 单文件产物。

```powershell
$env:BLENDER_EXECUTABLE = "D:\Blender\blender.exe"; $env:PYTHONPATH = "src"; python -m unittest discover -s tests -t . -v
```

没有检测到 Blender 时，真实集成测试会明确显示 `skipped`。测试覆盖全部工具成功／失败／越权、异常回滚、非目标副作用、GLB 和独立复验，以及四类自然语言指令、整装配复制、旋转局部轴、目标确认、计划绑定、低置信度、重试锁定、提交／结果写入故障、固定相机和进程超时。

Web 测试命令如下。

```powershell
npm test --prefix web
```

```powershell
npm run build --prefix web
```

```powershell
npm run test:ui --prefix web
```

```powershell
$env:BLENDGUARD_RUN_REAL_INTEGRATION = "1"; npm run test:integration --prefix web
```

## 自然语言编辑

### Web 工作台

```powershell
npm install --prefix web
```

```powershell
npm run build --prefix web
```

```powershell
npm run start --prefix web
```

打开 `http://127.0.0.1:8787`，选择源资产并生成计划。正式默认规划器是 DeepSeek；启动服务前需在同一个本机 shell 中设置 `DEEPSEEK_API_KEY`，例如使用 `$env:DEEPSEEK_API_KEY = Read-Host "DeepSeek API Key"`，不要把密钥写进命令历史、源码或聊天。确认、完整契约审阅和执行是独立步骤；只有独立 `VERIFIED` 后才显示 GLB 和交付下载。开发模式、API 和测试配置见 [web/README.md](web/README.md)。

### CLI：先只生成计划，不执行

```powershell
$env:PYTHONPATH = "src"; python -m blendguard agent --source assets\teaching_rack.blend --instruction "将 server_03 下移 1U" --run-dir runs\agent_move --planner deterministic --blender D:\Blender\blender.exe
```

确认计划后，使用新的空运行目录执行并导出 GLB：

```powershell
$env:PYTHONPATH = "src"; python -m blendguard agent --source assets\teaching_rack.blend --instruction "将 server_03 下移 1U" --run-dir runs\agent_move --plan-input runs\agent_move.plan.json --planner deterministic --execute --blender D:\Blender\blender.exe
```

独立复验：

```powershell
$env:PYTHONPATH = "src"; python -m blendguard verify --run-dir runs\agent_move --blender D:\Blender\blender.exe
```

离线教学指令还包括：

```text
把 server_02 宽度改为 0.5 米
复制 server_02 命名为 server_05，放到 [0.8, 0, 1.2]
给 server_03 添加 2 毫米倒角
```

真实 DeepSeek 规划器是 CLI 和正式 Web 的默认值，默认模型为 `deepseek-flash`。在本机启动服务的 shell 中设置 `DEEPSEEK_API_KEY`，不要写入源码、网页或聊天；可用 `DEEPSEEK_MODEL` 覆盖模型，`DEEPSEEK_BASE_URL` 覆盖官方地址。缺少密钥或 API 失败会明确报错，不会回退到离线解析器。只有显式指定 `--planner deterministic` 才使用离线教学模式。

完整确认、重试与路径说明见 [Agent 使用示例](examples/agent_demo.md)。

## 直接运行固定 JSON

不需要 Agent 的底层接口仍然保留：

```powershell
$env:PYTHONPATH = "src"; python -m blendguard run --request runs\move_request.json --blender D:\Blender\blender.exe
```

每个 Runner 运行目录必须为空。Agent 会话的根目录必须不存在，避免混入旧尝试和旧交付。

## 运行产物

```text
runs/<run>/
├── attempts/attempt_001/       # 原始尝试及事务证据
├── input/source.blend          # 成功尝试的只读源副本
├── reports/
│   ├── agent_plan.json         # 规划器、结构化意图和尝试记录
│   ├── contract.json
│   ├── plan.json
│   ├── initial_ir.json
│   ├── final_ir.json
│   ├── diff.json
│   ├── validation.json
│   ├── rollback_validation.json
│   ├── export_validation.json
│   └── independent_verification.json
├── delivery/
│   ├── output.blend
│   ├── output.glb
│   └── quality_report.json
└── result.json
```

`COMMITTED` 表示本次 Runner 门禁通过；`VERIFIED` 表示独立进程重新计算通过。二者都不是模型自述。

## 代码结构

```text
src/blendguard/
├── contracts.py         # 契约与操作解析
├── scene_ir.py          # 规范化、差异和派生规则
├── scene_summary.py     # 面向规划器的只读精简投影
├── planning.py          # DeepSeek／Claude／离线规划器与确定性契约编译
├── agent_session.py     # 独立尝试、重试锁定和成功提升
├── validators.py        # 确定性目标约束
├── workspace.py         # 哈希、副本、检查点与提交
├── blender_scene.py     # Blender Scene IR 提取
├── blender_inspect.py   # 只读场景检查进程
├── blender_tools.py     # 受控 bpy 工具
├── blender_export.py    # GLB 转换、导出与再导入
├── blender_preview.py   # 固定相机预览
├── blender_runner.py    # Blender 进程内事务流程
├── verifier.py          # 独立交付复验
└── cli.py               # 主机侧入口
```

Web 工作台结构：

```text
web/
├── src/                 # React 工作台、状态 Hook 和 Three.js 查看器
├── server/              # 受控 HTTP/SSE、会话、进程与产物门禁
├── shared/types.ts      # 前后端共享状态与报告类型
├── tests/               # Playwright 和真实 Blender 集成测试
├── README.md            # 启动、配置与测试
└── NOTICE.md            # 上游来源和许可证限制
```
