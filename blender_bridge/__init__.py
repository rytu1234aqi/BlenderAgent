# SPDX-License-Identifier: MIT
"""Blender Bridge（Studio 专用）

给 BlendGuard Studio 提供一条极窄的本机 HTTP 通道，不依赖 MCP：

- GET  /health                 → 版本/当前文件/是否已加载工程
- POST /snapshot  {path}      → 把当前场景另存一份到 path（copy=True，不动当前文件）
- POST /load      {path, backup?} → 用 path 替换当前场景（可先把当前场景备份到 backup）
- POST /export    {path}      → 把当前场景导出为 GLB

所有 bpy 操作都在主线程（bpy.app.timers）执行，HTTP 只负责收发。
令牌文件：%APPDATA%/blender-bridge/token（自动生成）。
"""

import hashlib
import http.server
import json
import os
import queue
import socketserver
import threading
import time
import traceback

import bpy

HOST = "127.0.0.1"
PORT = 9878
TASK_TIMEOUT = 180.0
TIMER_INTERVAL = 0.02

_QUEUE = queue.Queue()
_TIMER_REGISTERED = False
_HTTPD = None
_SERVER_THREAD = None
_LAST_INFO = {}


def _state_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "blender-bridge")


def _token_path():
    return os.path.join(_state_dir(), "token")


def _ensure_token():
    path = _token_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        import secrets

        with open(path, "w", encoding="utf-8") as handle:
            handle.write(secrets.token_hex(24))
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _main_thread_pump():
    try:
        while True:
            task = _QUEUE.get_nowait()
            _execute(task)
    except queue.Empty:
        pass
    return TIMER_INTERVAL


def _execute(task):
    op = task["op"]
    payload = task["payload"]
    result = {"ok": True}
    try:
        if op == "info":
            scene = bpy.context.scene
            result["data"] = {
                "version": bpy.app.version_string,
                "file": bpy.data.filepath or None,
                "objects": len(bpy.data.objects),
                "scene": scene.name if scene else None,
            }
            _LAST_INFO.update(result["data"])
        elif op == "snapshot":
            target = payload["path"]
            os.makedirs(os.path.dirname(target), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=target, copy=True)
            result["data"] = {
                "path": target,
                "size": os.path.getsize(target),
                "sha256": _sha256(target),
            }
        elif op == "load":
            target = payload["path"]
            if not os.path.exists(target):
                raise FileNotFoundError(target)
            backup = payload.get("backup")
            if backup:
                os.makedirs(os.path.dirname(backup), exist_ok=True)
                bpy.ops.wm.save_as_mainfile(filepath=backup, copy=True)
            bpy.ops.wm.open_mainfile(filepath=target)
            result["data"] = {
                "path": target,
                "backup": backup,
                "file": bpy.data.filepath or None,
                "objects": len(bpy.data.objects),
            }
        elif op == "export":
            target = payload["path"]
            os.makedirs(os.path.dirname(target), exist_ok=True)
            bpy.ops.export_scene.gltf(filepath=target, export_format="GLB", use_selection=False)
            result["data"] = {"path": target, "size": os.path.getsize(target)}
        else:
            raise ValueError(f"未知操作：{op}")
    except Exception as error:  # noqa: BLE001 - 交给客户端处理
        result = {"ok": False, "error": f"{type(error).__name__}: {error}", "traceback": traceback.format_exc(limit=4)}
    task["result"] = result
    task["event"].set()


def _submit(op, payload, timeout):
    event = threading.Event()
    task = {"op": op, "payload": payload, "event": event, "result": None}
    _QUEUE.put(task)
    if not event.wait(timeout):
        return {"ok": False, "error": f"Blender 主线程 {timeout:.0f}s 内没有响应（可能正忙或卡住）"}
    return task["result"] or {"ok": False, "error": "没有结果"}


class _Handler(http.server.BaseHTTPRequestHandler):
    server_version = "BlenderBridge/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):  # 静默日志
        pass

    def _allowed_token(self):
        header = self.headers.get("X-Bridge-Token", "")
        try:
            return bool(header) and header == _ensure_token()
        except OSError:
            return False

    def _send(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path not in ("/health", "/"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._allowed_token():
            self._send(401, {"ok": False, "error": "缺少或错误的 X-Bridge-Token"})
            return
        info = _submit("info", {}, 5.0)
        if not info.get("ok"):
            # 主线程忙时退回缓存，保证健康检查可用
            info = {"ok": True, "data": dict(_LAST_INFO) or {"version": bpy.app.version_string}}
        self._send(200, info)

    def do_POST(self):  # noqa: N802
        if not self._allowed_token():
            self._send(401, {"ok": False, "error": "缺少或错误的 X-Bridge-Token"})
            return
        routes = {"/snapshot": "snapshot", "/load": "load", "/export": "export"}
        op = routes.get(self.path)
        if not op:
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            self._send(400, {"ok": False, "error": "请求体不是合法 JSON"})
            return
        if not payload.get("path"):
            self._send(400, {"ok": False, "error": "缺少 path"})
            return
        result = _submit(op, payload, TASK_TIMEOUT)
        self._send(200 if result.get("ok") else 500, result)


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _start_server():
    global _HTTPD, _SERVER_THREAD, _TIMER_REGISTERED
    if _HTTPD is not None:
        return True
    if not _TIMER_REGISTERED:
        bpy.app.timers.register(_main_thread_pump, first_interval=TIMER_INTERVAL, persistent=True)
        _TIMER_REGISTERED = True
    try:
        _HTTPD = _Server((HOST, PORT), _Handler)
    except OSError as error:
        print(f"[blender-bridge] 无法监听 {HOST}:{PORT}：{error}")
        _HTTPD = None
        return False
    _SERVER_THREAD = threading.Thread(target=_HTTPD.serve_forever, name="blender-bridge", daemon=True)
    _SERVER_THREAD.start()
    _ensure_token()
    print(f"[blender-bridge] Listening on http://{HOST}:{PORT}")
    return True


def _stop_server():
    global _HTTPD, _SERVER_THREAD
    if _HTTPD is None:
        return
    _HTTPD.shutdown()
    _HTTPD.server_close()
    _HTTPD = None
    _SERVER_THREAD = None


class BRIDGE_OT_start(bpy.types.Operator):
    bl_idname = "blender_bridge.start"
    bl_label = "Start Bridge"
    bl_description = "启动本机 HTTP 桥接（Studio 建模用）"

    def execute(self, _context):
        ok = _start_server()
        self.report({"INFO"} if ok else {"ERROR"}, "Bridge 已启动" if ok else f"端口 {PORT} 被占用")
        return {"FINISHED"}


class BRIDGE_OT_stop(bpy.types.Operator):
    bl_idname = "blender_bridge.stop"
    bl_label = "Stop Bridge"
    bl_description = "停止本机 HTTP 桥接"

    def execute(self, _context):
        _stop_server()
        self.report({"INFO"}, "Bridge 已停止")
        return {"FINISHED"}


class BRIDGE_PT_panel(bpy.types.Panel):
    bl_label = "Studio Bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Bridge"

    def draw(self, _context):
        layout = self.layout
        running = _HTTPD is not None
        layout.label(text=f"端口 {PORT}：{'运行中' if running else '未启动'}")
        if running:
            layout.label(text="令牌：" + "已生成")
            layout.operator("blender_bridge.stop")
        else:
            layout.operator("blender_bridge.start")


_CLASSES = (BRIDGE_OT_start, BRIDGE_OT_stop, BRIDGE_PT_panel)


def register():
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    _start_server()


def unregister():
    _stop_server()
    for cls in reversed(_CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except RuntimeError:
            pass


if __name__ == "__main__":
    register()
