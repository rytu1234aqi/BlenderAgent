# BlendGuard 本地可信编辑工作台

这是 BlendGuard 的 React / Three.js 本地前端和受控 HTTP/SSE 适配层。它复用项目现有的 Python CLI、契约编译器、Blender Runner 和独立验证器，不在 Node 中重新实现编辑权限，也不提供自由 `bpy` 或 `execute_python` 入口。

正式服务默认规划器是 **DeepSeek LLM（`deepseek-flash`）**。它只生成结构化编辑意图，不接收 Blender 工具；`deterministic` 是显式选择的离线教学规划器，不是 LLM。本目录的自动测试使用模拟客户端或离线规划器，没有执行真实云端 DeepSeek 调用。

## 环境

- Node.js 20 或更新版本；本次使用 Node.js 24.12.0、npm 11.6.2。
- Python 3.11 或更新版本。
- Blender 4.4.3；可用 `BLENDER_EXECUTABLE` 指定程序。
- 项目根目录中的 `assets/teaching_rack.blend` 和 `src/blendguard/`。

## 安装

在项目根目录执行：

```powershell
npm install --prefix web
```

真实 DeepSeek 规划还需要主机 Python 的 OpenAI 兼容 SDK：

```powershell
python -m pip install -e ".[deepseek]"
```

## 开发模式

```powershell
npm run dev --prefix web
```

打开 `http://127.0.0.1:5173`。Vite 只代理 `/api` 到 `127.0.0.1:8787`，两个服务都绑定本机回环地址。

## 生产模式

先构建单文件前端：

```powershell
npm run build --prefix web
```

再在同一个本机 shell 中设置 DeepSeek 凭据并启动服务。输入不会进入项目文件或网页；不要把密钥粘贴到聊天中：

```powershell
$env:DEEPSEEK_API_KEY = Read-Host "DeepSeek API Key"
```

```powershell
npm run start --prefix web
```

打开 `http://127.0.0.1:8787`。`web/dist/index.html` 包含前端脚本和样式；GLB、固定预览和机器报告仍由受控 API 按需读取。

如果密钥已保存到当前 Windows 用户环境，也可以用普通 Python 启动器读取并传递给服务进程，不打印密钥、不修改 PowerShell 执行策略：

```powershell
python web\start_deepseek.py
```

## 使用流程

1. 在左栏选择资产目录中已有的 `.blend` 源文件。初始画面只是固定 PNG 源预览，不是复验结论。
2. 输入局部编辑指令，点击“生成编辑计划”。此步骤不会创建执行运行目录，也不会修改源工程。
3. 如果目标不唯一或置信度不足，先完成人工确认。确认只更新同一计划的契约和哈希，不会执行编辑；连续确认会保留此前选择。
4. 审阅目标、完整契约、写集、派生规则、约束、类型化工具参数和当前 SHA-256。
5. 勾选“我已审阅当前哈希…”，再单独点击“执行这份已审阅计划”。
6. Runner 先达到 `COMMITTED`，随后服务调用新 Blender 进程独立复验。此中间状态不发布交付。
7. 只有独立报告为 `VERIFIED`，页面才显示交互式 GLB、Blender 工程和质量报告下载。
8. 左栏可重新打开历史证据。已完成或历史计划是只读的，不能重复执行同一个运行目录。

“新编辑”只清空当前界面会话，不删除源文件、历史运行或交付。执行期间没有“杀进程即回滚”的虚假取消按钮；服务是单用户、单忙任务模式。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `8787` | 生产 HTTP 端口 |
| `PYTHON_EXECUTABLE` | `python` | 主机 Python |
| `BLENDER_EXECUTABLE` | 未设置时仅检查 Windows 的 `D:\Blender\blender.exe`；装在别处必须设置 | Blender 程序完整路径 |
| `BLENDGUARD_PLANNER` | `deepseek` | `deepseek`、`claude` 或显式离线 `deterministic`；空值和未知值会拒绝启动 |
| `DEEPSEEK_API_KEY` | 无 | DeepSeek 密钥，只从服务进程环境读取，不进入前端或报告 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | DeepSeek 模型；优先于通用 `BLENDGUARD_MODEL` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek OpenAI 兼容 API 地址 |
| `BLENDGUARD_MODEL` | 按提供方默认值 | 通用模型覆盖；Claude 默认 `claude-opus-5-5` |
| `BLENDGUARD_BLENDER_TIMEOUT` | `300` | 单个 Blender 子进程超时秒数 |
| `BLENDGUARD_PROCESS_TIMEOUT_MS` | `1200000` | 适配层主机进程超时 |
| `BLENDGUARD_ASSETS_DIR` | 项目 `assets/` | 已有源资产根目录 |
| `BLENDGUARD_WEB_RUNS_DIR` | 项目 `runs/web/` | Web 计划与运行根目录 |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | 本机 Chrome 路径 | 浏览器测试程序 |

选择 DeepSeek 后，精简场景摘要和用户指令会发送到 DeepSeek；不发送完整顶点表。密钥只由 Python 适配器从服务端环境读取，不能写入前端、源码、计划或报告。缺少密钥、OpenAI SDK 或 API 调用失败会明确报错，不会静默切换为离线解析器。Claude 仅作为显式 `--planner claude` 的可选兼容提供方保留。

## 受控接口

- `GET /api/status`、`GET /api/assets`、`GET /api/runs`、`GET /api/runs/:runId`
- `GET /api/events`：重连先发送完整快照，再发送真实状态、计划、运行、场景和时间线事件。
- `POST /api/plans`：只生成计划。
- `POST /api/plans/:planId/resolve`：绑定当前计划哈希，只解析确认。
- `POST /api/plans/:planId/execute`：核对当前哈希和审阅状态，执行同一计划并独立复验。
- `POST /api/session/reset`：非忙时清空界面会话，不删除文件。
- `GET /api/runs/:runId/artifacts/:kind`：固定映射 `plan`、`verification`、`blend`、`glb`、`quality`。
- `GET /api/assets/:assetId/previews/:view`：教学机柜已有的固定 PNG。

所有子进程使用参数数组和 `shell: false`。源资产按 basename、扩展名和 realpath containment 限制；运行 ID 使用固定格式；产物不接受任意路径。写操作要求 JSON、`X-BlendGuard-Client: workbench`，并检查 Host、Origin 和跨站请求标记。`blend`、`glb`、`quality` 每次请求都会重新读取独立报告，未 `VERIFIED` 不发布。

## 测试

后端单元测试：

```powershell
npm test --prefix web
```

类型检查与生产构建：

```powershell
npm run typecheck --prefix web
```

```powershell
npm run build --prefix web
```

真实 HTTP / Blender 集成测试：

```powershell
$env:BLENDGUARD_RUN_REAL_INTEGRATION = "1"; npm run test:integration --prefix web
```

浏览器测试使用本机 Chrome，包含真实计划、模拟目标确认和真实 Blender 执行。测试服务固定使用独立端口 `8788` 和 `BLENDGUARD_PLANNER=deterministic`，不会复用正式 DeepSeek 服务：

```powershell
npm run test:ui --prefix web
```

真实测试会在 `runs/web/` 创建新运行，不覆盖旧运行。集成证据写入 `runs/frontend_review/phase4_real_integration.json`，浏览器截图写入同目录。

## 运行文件

```text
runs/web/<runId>.plan.json          # 页面审阅与执行绑定的计划
runs/web/<runId>.resolution.json    # 已确认参数，供同一计划执行和重启恢复
runs/web/<runId>/
├── attempts/attempt_*/reports/events.jsonl
├── reports/independent_verification.json
├── delivery/output.blend
├── delivery/output.glb
├── delivery/quality_report.json
└── result.json
```

## 范围与许可证

不支持任意工程上传、源文件删除、自由 `bpy`、通用任意建模、多人协作或 Blender MCP。Scene IR 的覆盖限制仍以核心质量报告为准。

上游前端的来源、保留／移除内容和无 LICENSE 分发限制见 [NOTICE.md](NOTICE.md)。本地集成完成不等于获得公开再分发授权。
