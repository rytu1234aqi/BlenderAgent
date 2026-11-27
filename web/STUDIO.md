# Studio 模式：Blender 主战场 + 参考镜像 + 事务审计（无 MCP）

Studio 是工作台的第二种模式（默认），与既有的「可信编辑」模式共存。设计目标：**不牺牲建模自由度与质量**，同时保留审计、回退与提交门禁。

Studio 不使用 MCP，也不用 `execute_python`：模型每步只写一段 Blender 脚本，后端在**隔离的工作副本**里用无头 Blender 执行，并通过一个极窄的 Blender 插件（`blender_bridge`，本机 HTTP 9878）把改动在采纳后推回你打开的 Blender。

## 核心约定

1. **Blender 是唯一的建模端**。脚本以你打开的真实 `.blend` 为底，在 `--factory-startup` 的无头 Blender 里运行，完整支持 bpy：修改器、材质节点、灯光、相机、渲染自检，质量不打折。
2. **网页中部视口是参考镜像**。每步脚本执行后由无头 Blender 导出 GLB（`runs/web/chat/.sync/scene.glb`），经 SSE 推到网页，Three.js 加载；镜像只用于查看与注释。
3. **镜像只读、注释是意图**。在镜像上可以做 T/R/S（平移/旋转/缩放）与选中部件，但这些改动**不会**直接写入 Blender；点「记入建议」后变成一句话进入输入框，发送后由 Agent 在 Blender 侧真正执行。
4. **每个用户回合开始前自动写审计点**：后端通过 Bridge 调用 `bpy.ops.wm.save_as_mainfile(copy=True)`，把**当前活会话**（含未保存改动）快照到 `turns/<turnId>/baseline.blend`，并记录 sha256 与 manifest；工作副本 `working.blend` 由此复制而来。
5. **采纳 = 提交 + 推回 Blender**：`POST /api/chat/commit` 把工作副本写成 `output.blend` + `audit.json`（含 journal、基线/最终哈希），再通过 Bridge 备份现场并 `open_mainfile(output.blend)`，让真实 Blender 会话显示你审阅过的结果。
6. **回退 = 恢复基线**：`POST /api/chat/revert` 通过 Bridge 加载本回合基线（或会话基线），恢复前会先把当前现场备份为 `.revert-backup.blend`。

> 说明：Agent 探索发生在工作副本里，所以你审阅期间继续在 Blender 里动手也不会被覆盖；只有点「采纳本回合」那一刻才会替换真实会话（替换前自动备份）。

## 安装与启动

```powershell
# 1) 安装桥接插件（只需一次；本仓库已带源码与打包好的 zip）
#    Blender → Edit > Preferences > Get Extensions → Install from File，选 blender_bridge.zip
#    （若用旧式 Add-ons 安装入口，选 blender_bridge_legacy.zip）
#    启用 "Blender Bridge (Studio)" 后，N 面板出现「Bridge」标签，点 Start Bridge（监听 127.0.0.1:9878）
#    首次启用会在 %APPDATA%\blender-bridge\token 生成令牌，后端自动读取

# 2) 使用前先确认 BlenderAgent-main/.env 里这两项（改完重启后端生效）：
#    DEEPSEEK_API_KEY=你的 Key（必填，否则对话被拒绝）
#    BLENDER_EXECUTABLE=Blender 完整路径（装在 D:\Blender\blender.exe 时保持默认；否则改为你的路径）
# 其余可选：
# BLENDER_BRIDGE_URL=http://127.0.0.1:9878
# BLENDER_SCRIPT_TIMEOUT_MS=180000
# BLENDGUARD_WEB_RUNS_DIR=runs/web

cd web
npm install --ignore-scripts
npm run build
npm run start        # 默认 8787
```

浏览器打开 `http://127.0.0.1:8787`。顶部「Studio 建模 / 可信编辑」可切换模式；左栏底部显示 `Bridge connected` 即链路就绪。

## 一次典型回话

1. 右栏输入「做一盏北欧风格的台灯，木质底座，暖光」，Enter 发送。
2. 后端写入审计点（Bridge 快照 + sha256），复制出工作副本，建立 manifest / journal。
3. Agent 循环输出脚本（`run_blender_script`）：建模 → 细节 → 材质 → 布光相机 → **自检脚本**（统计对象/尺寸/材质/灯光/相机）；每步由无头 Blender 执行、保存副本并导出 GLB。
4. 视口根据 GLB 实时刷新；左栏可见本回合哈希、「立即同步」与回退按钮。
5. 满意 → 「采纳本回合」，工作副本变成 `output.blend` 并推回真实 Blender；不满意 → 「回退本回合」或「回退到对话前」。
6. 最近回合列表可刷新查看历史审计包。

## Bridge 协议（供二次开发/排障）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | `{ok, data:{version,file,objects,scene}}` |
| POST | `/snapshot` | `{path}` → 当前场景另存快照（不动当前文件） |
| POST | `/load` | `{path,backup?}` → 备份现场后加载 `path` |
| POST | `/export` | `{path}` → 导出 GLB |

所有请求需带 `X-Bridge-Token`（读 `%APPDATA%\blender-bridge\token`）；bpy 调用经主线程队列执行，默认 180s 超时。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chat/events` | SSE：snapshot / entry / delta / patch / status / scene / clear |
| GET | `/api/chat/status` | Bridge / Blender / DeepSeek 连接态、当前回合 |
| GET | `/api/chat/turns` | 最近回合与提交状态 |
| GET | `/api/chat/scene` | 当前参考镜像 GLB |
| POST | `/api/chat/message` | 发消息；若有待答问题则作为回答提交 |
| POST | `/api/chat/answer` | 回答 Agent 的问题 |
| POST | `/api/chat/cancel` | 取消当前回合 |
| POST | `/api/chat/reconnect` | 重连 Bridge（重新探测 9878） |
| POST | `/api/chat/sync` | 立即从活会话重新导出镜像 |
| POST | `/api/chat/commit` | 采纳当前回合（写 output.blend 并推回 Blender） |
| POST | `/api/chat/revert` | 回退（`{"scope":"turn"|"conversation"}`） |
| POST | `/api/chat/reset` | 清空对话与事务状态 |

写接口需带 `X-BlendGuard-Client: workbench`（前端自动附带），与既有安全中间件一致。

## 产物

```text
runs/web/chat/
├── .sync/scene.glb              # 参考镜像（只读）
└── <conversationId>/
    ├── baseline.blend           # 对话开始前的真实快照
    ├── conversation.json        # 会话元数据
    └── turns/<turnId>/
        ├── baseline.blend       # 本回合审计点（活会话快照）
        ├── working.blend        # 隔离工作副本（Agent 只动这个）
        ├── scripts/step-N/      # 每步脚本 + wrapper + 导出的 GLB
        ├── manifest.json        # 指令、基线/最终哈希、状态
        ├── journal.jsonl        # 每步脚本执行与结果摘要
        └── output.blend + audit.json   # 采纳后生成，并推回 Blender
```
