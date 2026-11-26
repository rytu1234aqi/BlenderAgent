import type { Request, RequestHandler, Response } from "express";
import type { AppConfig } from "./config";

function allowedOrigins(config: AppConfig): Set<string> {
  const origins = new Set<string>();
  for (const port of new Set([config.port, 5173])) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://[::1]:${port}`);
  }
  return origins;
}

export function createSecurityMiddleware(config: AppConfig): RequestHandler {
  const origins = allowedOrigins(config);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (!hosts.has(req.headers.host ?? "")) {
      res.status(403).json({ error: { code: "HOST_NOT_ALLOWED", message: "只允许通过本机地址访问工作台。" } });
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: { code: "CROSS_SITE_DENIED", message: "已拒绝跨站请求。" } });
      return;
    }
    if (req.method === "OPTIONS") {
      res.status(403).json({ error: { code: "CORS_DENIED", message: "工作台不允许跨域调用。" } });
      return;
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) {
        res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "请求来源不在本机允许列表中。" } });
        return;
      }
      if (req.headers["x-blendguard-client"] !== "workbench" || !req.is("application/json")) {
        res.status(403).json({ error: { code: "CLIENT_HEADER_REQUIRED", message: "写操作必须来自 BlendGuard 工作台。" } });
        return;
      }
    }
    next();
  };
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "接口不存在。" } });
}
