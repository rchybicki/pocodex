import { execFile, spawn } from "node:child_process";
import { platform as readPlatform } from "node:os";

import { debugLog } from "./debug.js";

const CODEX_THREAD_DEEPLINK_PATTERN =
  /^codex:\/\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_REFRESH_DELAY_MS = 2_000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 8_000;
const DEFAULT_OPEN_SETTLE_MS = 900;
const DEFAULT_MINI_WINDOW_CLOSE_DELAY_MS = 2_000;

export interface NativeCodexRefreshQueue {
  close(): void;
  queueThreadRefresh(threadId: string, reason?: string): void;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type RunCommand = (
  file: string,
  args: string[],
  options?: {
    timeoutMs?: number;
  },
) => Promise<CommandResult>;

export interface NativeCodexRefreshControllerOptions {
  enabled?: boolean;
  platform?: NodeJS.Platform;
  refreshDelayMs?: number;
  minRefreshIntervalMs?: number;
  commandTimeoutMs?: number;
  openSettleMs?: number;
  miniWindowCloseDelayMs?: number;
  runCommand?: RunCommand;
  getClipboard?: () => Promise<string>;
  setClipboard?: (value: string) => Promise<void>;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export class NativeCodexRefreshController implements NativeCodexRefreshQueue {
  private readonly enabled: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly refreshDelayMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly commandTimeoutMs: number;
  private readonly openSettleMs: number;
  private readonly miniWindowCloseDelayMs: number;
  private readonly runCommand: RunCommand;
  private readonly getClipboard: () => Promise<string>;
  private readonly setClipboard: (value: string) => Promise<void>;
  private readonly now: () => number;
  private readonly setTimer: typeof globalThis.setTimeout;
  private readonly clearTimer: typeof globalThis.clearTimeout;
  private readonly pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queuedThreadIds: string[] = [];
  private readonly queuedThreadIdSet = new Set<string>();
  private readonly nextAllowedRefreshAtMs = new Map<string, number>();
  private isClosed = false;
  private isRunning = false;

  constructor(options: NativeCodexRefreshControllerOptions = {}) {
    this.platform = options.platform ?? readPlatform();
    this.enabled = options.enabled ?? this.platform === "darwin";
    this.refreshDelayMs = Math.max(0, options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS);
    this.minRefreshIntervalMs = Math.max(
      0,
      options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS,
    );
    this.commandTimeoutMs = Math.max(1_000, options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    this.openSettleMs = Math.max(0, options.openSettleMs ?? DEFAULT_OPEN_SETTLE_MS);
    this.miniWindowCloseDelayMs = Math.max(
      0,
      options.miniWindowCloseDelayMs ?? DEFAULT_MINI_WINDOW_CLOSE_DELAY_MS,
    );
    this.runCommand = options.runCommand ?? runCommand;
    this.getClipboard =
      options.getClipboard ??
      (async () => {
        const result = await this.runCommand("/usr/bin/pbpaste", [], {
          timeoutMs: this.commandTimeoutMs,
        });
        return result.stdout;
      });
    this.setClipboard = options.setClipboard ?? writeClipboard;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  }

  queueThreadRefresh(threadId: string, reason = "thread activity"): void {
    if (!this.enabled || this.isClosed || this.platform !== "darwin") {
      return;
    }
    if (!THREAD_ID_PATTERN.test(threadId)) {
      return;
    }

    const now = this.now();
    const nextAllowed = this.nextAllowedRefreshAtMs.get(threadId) ?? 0;
    if (now < nextAllowed) {
      return;
    }
    if (this.pendingTimers.has(threadId) || this.queuedThreadIdSet.has(threadId)) {
      return;
    }

    const timer = this.setTimer(() => {
      this.pendingTimers.delete(threadId);
      this.enqueueThreadRefresh(threadId);
    }, this.refreshDelayMs);
    timer.unref?.();
    this.pendingTimers.set(threadId, timer);

    debugLog("native-refresh", "queued native Codex thread refresh", {
      reason,
      threadId,
    });
  }

  close(): void {
    this.isClosed = true;
    for (const timer of this.pendingTimers.values()) {
      this.clearTimer(timer);
    }
    this.pendingTimers.clear();
    this.queuedThreadIds.length = 0;
    this.queuedThreadIdSet.clear();
  }

  private enqueueThreadRefresh(threadId: string): void {
    if (this.isClosed || this.queuedThreadIdSet.has(threadId)) {
      return;
    }

    this.queuedThreadIds.push(threadId);
    this.queuedThreadIdSet.add(threadId);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      while (!this.isClosed) {
        const threadId = this.queuedThreadIds.shift();
        if (!threadId) {
          return;
        }
        this.queuedThreadIdSet.delete(threadId);
        this.nextAllowedRefreshAtMs.set(threadId, this.now() + this.minRefreshIntervalMs);

        try {
          await this.refreshThread(threadId);
        } catch (error) {
          debugLog("native-refresh", "failed to refresh native Codex thread", {
            error: error instanceof Error ? error.message : String(error),
            threadId,
          });
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async refreshThread(threadId: string): Promise<void> {
    const previousDeeplink = await this.captureCurrentThreadDeeplink().catch((error) => {
      debugLog("native-refresh", "failed to capture current native Codex thread", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    const targetDeeplink = `codex://threads/${threadId}`;

    await this.runCommand("/usr/bin/open", [targetDeeplink], {
      timeoutMs: this.commandTimeoutMs,
    });
    await delay(this.openSettleMs);
    await this.runAppleScript(buildOpenMiniWindowScript(this.miniWindowCloseDelayMs));

    if (previousDeeplink && previousDeeplink !== targetDeeplink) {
      await this.runCommand("/usr/bin/open", [previousDeeplink], {
        timeoutMs: this.commandTimeoutMs,
      }).catch((error) => {
        debugLog("native-refresh", "failed to restore previous native Codex thread", {
          error: error instanceof Error ? error.message : String(error),
          previousDeeplink,
        });
      });
    }
  }

  private async captureCurrentThreadDeeplink(): Promise<string | null> {
    const previousClipboard = await this.getClipboard();
    try {
      await this.runAppleScript([
        'tell application "Codex" to activate',
        "delay 0.2",
        'tell application "System Events"',
        '  tell process "Codex"',
        '    keystroke "l" using {command down, option down}',
        "  end tell",
        "end tell",
        "delay 0.25",
      ]);
      const clipboard = (await this.getClipboard()).trim();
      return CODEX_THREAD_DEEPLINK_PATTERN.test(clipboard) ? clipboard : null;
    } finally {
      await this.setClipboard(previousClipboard).catch((error) => {
        debugLog("native-refresh", "failed to restore clipboard after deeplink capture", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async runAppleScript(lines: string[]): Promise<CommandResult> {
    return await this.runCommand(
      "/usr/bin/osascript",
      lines.flatMap((line) => ["-e", line]),
      {
        timeoutMs: this.commandTimeoutMs,
      },
    );
  }
}

export function isNativeCodexRefreshEnabledByEnv(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

export function parseNativeCodexRefreshIntervalMs(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.round(seconds * 1_000);
}

function buildOpenMiniWindowScript(closeDelayMs: number): string[] {
  return [
    'tell application "Codex" to activate',
    "delay 0.2",
    'tell application "System Events"',
    '  tell process "Codex"',
    "    set windowCountBefore to count of windows",
    "    key code 53",
    "    delay 0.15",
    '    keystroke "k" using {command down}',
    "    delay 0.3",
    '    keystroke "Open in Mini Window"',
    "    delay 0.2",
    "    key code 36",
    `    delay ${formatAppleScriptDelay(closeDelayMs)}`,
    "    set windowCountAfter to count of windows",
    "    if windowCountAfter > windowCountBefore then",
    '      keystroke "w" using {command down}',
    "    end if",
    "  end tell",
    "end tell",
  ];
}

function formatAppleScriptDelay(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1_000).toFixed(2);
}

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runCommand(
  file: string,
  args: string[],
  options: {
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({
          stderr,
          stdout,
        });
      },
    );
  });
}

function writeClipboard(value: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/usr/bin/pbcopy", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(Buffer.concat(stderrChunks).toString("utf8").trim() || "pbcopy failed"));
    });
    child.stdin.end(value);
  });
}
