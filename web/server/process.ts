import { spawn } from "node:child_process";
import path from "node:path";
import type { AppConfig } from "./config";
import { WebError } from "./errors";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

function compactOutput(value: string): string {
  return value.length > 6000 ? `${value.slice(0, 3000)}\n…\n${value.slice(-3000)}` : value;
}

export function createCommandRunner(config: AppConfig): CommandRunner {
  return (args: string[]) => new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(config.python, ["-m", "blendguard", ...args], {
      cwd: config.rootDir,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: [path.join(config.rootDir, "src"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure: WebError | null = null;

    const fail = (error: WebError) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        settled = true;
        reject(error);
      }
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (settled || failure) return;
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > config.maxProcessOutput) {
        fail(new WebError("PROCESS_OUTPUT_LIMIT", "BlendGuard 子进程输出超过本地服务限制。", 502));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new WebError("PROCESS_START_FAILED", `无法启动 Python：${error.message}`, 503));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    const timer = setTimeout(() => {
      fail(new WebError("PROCESS_TIMEOUT", "BlendGuard 主机进程超过适配层时限；请检查运行目录，不能据此宣称已回滚。", 504));
    }, config.processTimeoutMs);
    timer.unref();
  });
}

export function processFailure(result: CommandResult, fallback: string): WebError {
  const output = compactOutput(result.stderr.trim() || result.stdout.trim());
  return new WebError("BLENDGUARD_COMMAND_FAILED", fallback, 502, {
    exitCode: result.code,
    output: output || "（无子进程输出）",
  });
}
