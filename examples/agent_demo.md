# BlendGuard Agent 与 Web 使用示例

以下命令均在项目根目录执行。`deterministic` 是明确标注的离线教学指令解析器，**不是大语言模型**；它用于在没有 API 凭据时验证同一条契约、工具、事务和复验链路。

## 本地 Web 工作台

安装并构建前端：

```powershell
npm install --prefix web
```

```powershell
npm run build --prefix web
```

正式 Web 默认使用 DeepSeek，启动前需完成下方的 SDK 安装和本机密钥配置。只在离线演示时，才显式设置 `$env:BLENDGUARD_PLANNER = "deterministic"`。

启动本机服务：

```powershell
npm run start --prefix web
```

打开 `http://127.0.0.1:8787`：

1. 选择 `teaching_rack.blend`，输入“将 server_03 下移 1U”。
2. 点击“生成编辑计划”；此时没有执行运行目录，也没有修改源文件。
3. 审阅契约、写集、派生规则、约束、工具参数和计划 SHA-256。
4. 勾选当前哈希的审阅确认，单独点击“执行这份已审阅计划”。
5. 等待 Runner `COMMITTED` 和新进程独立 `VERIFIED`，再查看 GLB 或下载工程与报告。

如果需要目标或低置信度确认，确认按钮只生成更新后的计划，仍需再次审阅。历史运行不能重复执行。开发模式、接口、环境变量和测试见 [../web/README.md](../web/README.md)。

## CLI：生成机柜与固定预览

```powershell
D:\Blender\blender.exe --background --factory-startup --disable-autoexec --python examples\teaching_rack.py -- E:\code\BlenderAgent\assets\teaching_rack.blend
```

```powershell
$env:PYTHONPATH = "src"; python -m blendguard preview --source assets\teaching_rack.blend --output-dir assets\previews --blender D:\Blender\blender.exe
```

预览相机为 `Preview_Overview`、`Preview_Front`、`Preview_Right`、`Preview_Cable`。渲染器不保存场景，不修改源工程。

## 只生成计划，不执行

```powershell
$env:PYTHONPATH = "src"; python -m blendguard agent --source assets\teaching_rack.blend --instruction "将 server_03 下移 1U" --run-dir runs\agent_move --planner deterministic --blender D:\Blender\blender.exe
```

计划默认写到 `runs\agent_move.plan.json`。没有 `--execute` 时不会创建 Blender 运行目录或交付文件。

## 执行并导出 GLB

```powershell
$env:PYTHONPATH = "src"; python -m blendguard agent --source assets\teaching_rack.blend --instruction "将 server_03 下移 1U" --run-dir runs\agent_move --plan-input runs\agent_move.plan.json --planner deterministic --execute --blender D:\Blender\blender.exe
```

`--plan-input` 会校验源文件、场景摘要、原指令和结构化意图，然后执行该文件中的同一提案，不会重新请求模型。

```powershell
$env:PYTHONPATH = "src"; python -m blendguard verify --run-dir runs\agent_move --blender D:\Blender\blender.exe
```

移动会读取 `asset_manifest.json` 中已经连接的端口关系，自动加入线缆末控制点更新和 `endpoint_distance` 检查。声明的连接若在初始场景中并未接上，规划会被拒绝。

其余离线教学指令：

```text
把 server_02 宽度改为 0.5 米
复制 server_02 命名为 server_05，放到 [0.8, 0, 1.2]
给 server_03 添加 2 毫米倒角
```

复制位置是对象原点的**世界坐标**，尺寸和倒角宽度使用米或毫米。移动中的 `1U` 固定等于 `0.04445m`，轴是目标的本地轴。复制服务器会复制其全部 Mesh／Empty 后代，保留父子关系并共享网格数据；每个新对象都需要独立写权限。

## DeepSeek 结构化规划器（默认）

安装 OpenAI 兼容 SDK：

```powershell
python -m pip install -e ".[deepseek]"
```

在启动 CLI 或 Web 服务的同一个本机 shell 中配置 `DEEPSEEK_API_KEY`，不要把密钥写入源码、网页、请求、运行报告或聊天：

```powershell
$env:DEEPSEEK_API_KEY = Read-Host "DeepSeek API Key"
```

默认使用官方 `https://api.deepseek.com` 和 `deepseek-flash`。可通过 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` 覆盖；`BLENDGUARD_MODEL` 是通用模型覆盖项，显式 `--model` 优先级最高。

以下只生成计划，不执行 Blender 编辑；省略 `--planner` 时默认就是 `deepseek`：

```powershell
$env:PYTHONPATH = "src"; python -m blendguard agent --source assets\teaching_rack.blend --instruction "将 server_03 下移 1U" --run-dir runs\deepseek_move --blender D:\Blender\blender.exe
```

审阅 `runs\deepseek_move.plan.json` 后，使用同一计划文件执行，不会重新请求模型：

```powershell
$env:PYTHONPATH = "src"; python -m blendguard agent --source assets\teaching_rack.blend --instruction "将 server_03 下移 1U" --run-dir runs\deepseek_move --plan-input runs\deepseek_move.plan.json --execute --blender D:\Blender\blender.exe
```

DeepSeek 只返回一个 JSON 编辑意图，不接收工具。宿主会拒绝空响应、截断、非法 JSON、缺失／额外字段和非法参数，再编译契约与写集。缺少密钥、SDK 或 API 调用失败会返回非零状态，不会静默回退到 `deterministic`。

Claude 适配器仅作为显式可选兼容项保留：安装 `python -m pip install -e ".[claude]"`，并传入 `--planner claude`；其默认模型仍为 `claude-opus-5-5`。

真实 DeepSeek 验收已完成 `READY → COMMITTED → VERIFIED`：一次真实云端规划后，通过 `--plan-input` 执行同一计划，没有重新请求模型；独立复验的非目标未授权差异为 0。完整通用 Blender 回归仍使用 deterministic，模拟客户端测试不冒充云端调用。

## 确认和重试

- 目标不唯一：返回 `TARGET_AMBIGUOUS`，不会执行；在生成的计划文件中审阅候选，再通过 `--plan-input <计划文件> --confirm-target <object_id>` 选择候选之一。
- 置信度低于 `0.85`：返回 `CONFIRMATION_REQUIRED`；审阅同一计划文件后使用 `--plan-input <计划文件> --approve-low-confidence`。
- 两种确认都必须绑定既有计划，不能在确认时重新规划；计划对应的源哈希、场景摘要、指令或结构化意图变化会返回 `PLAN_APPROVAL_MISMATCH`。
- `--retry-budget 1` 或 `2`：只对有限的执行/目标失败进行重规划，每次使用独立尝试目录。
- 重试不能改变原契约、目标约束、写集、工具名称、对象 ID 或新对象名称；只能调整数值参数。
- 非目标差异、权限拒绝、源文件变化和导出失败不会自动重试。
- 只有最终成功尝试会复制到根运行目录的 `delivery/`；历史尝试保留在 `attempts/` 供审计。
- 每个 Blender 子进程默认超时为 300 秒，可用 `--blender-timeout <秒>` 调整；超时、提交或结果写入失败不会提升交付。

无论使用哪种规划器，`COMMITTED` 都来自 Runner 的真实目标、局部性和导出检查；`VERIFIED` 只来自独立复验进程。模型不能自行宣布成功。
