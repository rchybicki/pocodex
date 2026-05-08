import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { debugLog } from "./debug.js";

const SESSION_FILE_NAME_PATTERN =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RECENT_FILE_LIMIT = 80;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const RECENT_WRITE_ACTIVE_GRACE_MS = 5 * 60 * 1_000;

export interface CodexSessionActivity {
  conversationId: string;
  active: boolean;
  path: string;
  title: string | null;
  updatedAtMs: number;
}

interface SessionFileSnapshot {
  active: boolean;
  conversationId: string;
  mtimeMs: number;
  path: string;
  size: number;
  title: string | null;
  updatedAtMs: number;
}

export interface CodexSessionActivityWatcherOptions {
  codexHomePath: string;
  onActivity: (activity: CodexSessionActivity) => void;
  activeGraceMs?: number;
  pollIntervalMs?: number;
  recentFileLimit?: number;
  tailBytes?: number;
}

interface ParsedJsonRecord {
  payload?: unknown;
  timestamp?: unknown;
  type?: unknown;
}

interface TaskEvent {
  timestampMs: number;
  turnId: string | null;
}

export class CodexSessionActivityWatcher {
  private readonly codexHomePath: string;
  private readonly onActivity: (activity: CodexSessionActivity) => void;
  private readonly activeGraceMs: number;
  private readonly pollIntervalMs: number;
  private readonly recentFileLimit: number;
  private readonly tailBytes: number;
  private readonly snapshotsByPath = new Map<string, SessionFileSnapshot>();
  private pollPromise: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private hasCompletedInitialPoll = false;
  private isClosed = false;

  constructor(options: CodexSessionActivityWatcherOptions) {
    this.codexHomePath = options.codexHomePath;
    this.onActivity = options.onActivity;
    this.activeGraceMs = options.activeGraceMs ?? RECENT_WRITE_ACTIVE_GRACE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.recentFileLimit = options.recentFileLimit ?? DEFAULT_RECENT_FILE_LIMIT;
    this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  }

  start(): void {
    if (this.timer || this.isClosed) {
      return;
    }

    void this.pollNow();
    this.timer = setInterval(() => {
      void this.pollNow();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  close(): void {
    this.isClosed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollNow(): Promise<void> {
    if (this.isClosed) {
      return;
    }
    if (this.pollPromise) {
      return this.pollPromise;
    }

    this.pollPromise = this.pollOnce().finally(() => {
      this.pollPromise = null;
    });
    return this.pollPromise;
  }

  emitKnownActiveActivities(): void {
    const nowMs = Date.now();
    for (const snapshot of this.snapshotsByPath.values()) {
      if (snapshot.active && !isStaleActiveSnapshot(snapshot, nowMs, this.activeGraceMs)) {
        this.emitActivity(snapshot);
      }
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const files = await listRecentCodexSessionFiles(this.codexHomePath, this.recentFileLimit);
      const threadTitles = await readCodexSessionIndexTitles(this.codexHomePath);
      const nextPaths = new Set(files.map((file) => file.path));
      const nowMs = Date.now();

      for (const file of files) {
        const previous = this.snapshotsByPath.get(file.path);
        if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
          if (previous.active && isStaleActiveSnapshot(previous, nowMs, this.activeGraceMs)) {
            const nextSnapshot: SessionFileSnapshot = {
              ...previous,
              active: false,
            };
            this.snapshotsByPath.set(file.path, nextSnapshot);
            this.emitActivity(nextSnapshot);
          }
          continue;
        }

        const activity = await readCodexSessionActivity(file.path, {
          activeGraceMs: this.activeGraceMs,
          fallbackUpdatedAtMs: file.mtimeMs,
          nowMs,
          size: file.size,
          tailBytes: this.tailBytes,
        });
        if (!activity) {
          continue;
        }

        const nextSnapshot: SessionFileSnapshot = {
          ...activity,
          mtimeMs: file.mtimeMs,
          size: file.size,
          title: threadTitles.get(activity.conversationId) ?? activity.title,
        };
        this.snapshotsByPath.set(file.path, nextSnapshot);

        const shouldEmit =
          this.hasCompletedInitialPoll ||
          nextSnapshot.active ||
          previous?.active !== nextSnapshot.active;
        if (shouldEmit) {
          this.emitActivity(nextSnapshot);
        }
      }

      for (const path of this.snapshotsByPath.keys()) {
        if (!nextPaths.has(path)) {
          this.snapshotsByPath.delete(path);
        }
      }

      this.hasCompletedInitialPoll = true;
    } catch (error) {
      debugLog("session-activity", "failed to poll Codex sessions", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitActivity(activity: CodexSessionActivity): void {
    this.onActivity({
      active: activity.active,
      conversationId: activity.conversationId,
      path: activity.path,
      title: activity.title,
      updatedAtMs: activity.updatedAtMs,
    });
  }
}

export function parseCodexSessionActivityJsonl(
  content: string,
  options: {
    fallbackConversationId?: string | null;
    fallbackUpdatedAtMs: number;
    activeGraceMs?: number;
    nowMs?: number;
    path: string;
    partialTail?: boolean;
  },
): CodexSessionActivity | null {
  let conversationId = options.fallbackConversationId ?? null;
  let latestStarted: TaskEvent | null = null;
  let latestCompleted: TaskEvent | null = null;
  const completedTurnIds = new Set<string>();
  let latestTimestampMs = Number.isFinite(options.fallbackUpdatedAtMs)
    ? options.fallbackUpdatedAtMs
    : Date.now();

  for (const line of content.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{")) {
      continue;
    }

    let record: ParsedJsonRecord;
    try {
      record = JSON.parse(trimmedLine) as ParsedJsonRecord;
    } catch {
      continue;
    }

    const recordTimestampMs = readRecordTimestampMs(record, latestTimestampMs);
    latestTimestampMs = Math.max(latestTimestampMs, recordTimestampMs);

    if (record.type === "session_meta") {
      const metaId = readNestedString(record.payload, ["id"]);
      if (metaId) {
        conversationId = metaId;
      }
      continue;
    }

    if (record.type !== "event_msg") {
      continue;
    }

    const eventType = readNestedString(record.payload, ["type"]);
    if (
      eventType !== "task_started" &&
      eventType !== "task_complete" &&
      eventType !== "turn_aborted"
    ) {
      continue;
    }

    const event: TaskEvent = {
      timestampMs: recordTimestampMs,
      turnId: readNestedString(record.payload, ["turn_id"]),
    };

    if (eventType === "task_started") {
      if (!latestStarted || event.timestampMs >= latestStarted.timestampMs) {
        latestStarted = event;
      }
      continue;
    }

    if (!latestCompleted || event.timestampMs >= latestCompleted.timestampMs) {
      latestCompleted = event;
    }
    if (event.turnId) {
      completedTurnIds.add(event.turnId);
    }
  }

  conversationId ??= extractConversationIdFromSessionPath(options.path);
  if (!conversationId) {
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const activeGraceMs = options.activeGraceMs ?? RECENT_WRITE_ACTIVE_GRACE_MS;
  const isRecentlyWritten = nowMs - options.fallbackUpdatedAtMs <= activeGraceMs;
  let active = false;
  if (latestStarted) {
    active =
      isRecentlyWritten &&
      (latestStarted.turnId !== null
        ? !completedTurnIds.has(latestStarted.turnId)
        : latestStarted.timestampMs > (latestCompleted?.timestampMs ?? 0));
  } else if (options.partialTail === true && !latestCompleted && isRecentlyWritten) {
    active = true;
  }

  return {
    active,
    conversationId,
    path: options.path,
    title: null,
    updatedAtMs: latestTimestampMs,
  };
}

export function extractConversationIdFromSessionPath(path: string): string | null {
  return SESSION_FILE_NAME_PATTERN.exec(path)?.[1] ?? null;
}

async function listRecentCodexSessionFiles(
  codexHomePath: string,
  limit: number,
): Promise<Array<{ mtimeMs: number; path: string; size: number }>> {
  const sessionsRoot = join(codexHomePath, "sessions");
  const paths = await listSessionJsonlPaths(sessionsRoot);
  const files = await Promise.all(
    paths.map(async (path) => {
      try {
        const fileStat = await stat(path);
        if (!fileStat.isFile()) {
          return null;
        }
        return {
          mtimeMs: fileStat.mtimeMs,
          path,
          size: fileStat.size,
        };
      } catch {
        return null;
      }
    }),
  );

  return files
    .filter((file): file is { mtimeMs: number; path: string; size: number } => file !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, Math.max(1, limit));
}

async function listSessionJsonlPaths(root: string): Promise<string[]> {
  const entries = await readDirectorySafe(root);
  const paths: string[] = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listSessionJsonlPaths(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      paths.push(entryPath);
    }
  }

  return paths;
}

async function readDirectorySafe(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readCodexSessionActivity(
  path: string,
  options: {
    activeGraceMs: number;
    fallbackUpdatedAtMs: number;
    nowMs: number;
    size: number;
    tailBytes: number;
  },
): Promise<CodexSessionActivity | null> {
  const fallbackConversationId = extractConversationIdFromSessionPath(path);
  const bytesToRead = Math.min(options.size, options.tailBytes);
  if (bytesToRead <= 0) {
    return fallbackConversationId
      ? {
          active: false,
          conversationId: fallbackConversationId,
          path,
          title: null,
          updatedAtMs: options.fallbackUpdatedAtMs,
        }
      : null;
  }

  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const start = Math.max(0, options.size - bytesToRead);
    const result = await file.read(buffer, 0, bytesToRead, start);
    let content = buffer.subarray(0, result.bytesRead).toString("utf8");
    const partialTail = start > 0;
    if (partialTail) {
      const firstNewline = content.indexOf("\n");
      content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }

    return parseCodexSessionActivityJsonl(content, {
      activeGraceMs: options.activeGraceMs,
      fallbackConversationId,
      fallbackUpdatedAtMs: options.fallbackUpdatedAtMs,
      nowMs: options.nowMs,
      partialTail,
      path,
    });
  } finally {
    await file.close();
  }
}

function isStaleActiveSnapshot(
  snapshot: SessionFileSnapshot,
  nowMs: number,
  activeGraceMs: number,
): boolean {
  return nowMs - snapshot.mtimeMs > activeGraceMs;
}

export function parseCodexSessionIndexTitles(content: string): Map<string, string> {
  const titles = new Map<string, string>();

  for (const line of content.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{")) {
      continue;
    }

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmedLine) as Record<string, unknown>;
    } catch {
      continue;
    }

    const id = typeof record.id === "string" ? record.id.trim() : "";
    const title = typeof record.thread_name === "string" ? record.thread_name.trim() : "";
    if (id && title) {
      titles.set(id, title);
    }
  }

  return titles;
}

async function readCodexSessionIndexTitles(codexHomePath: string): Promise<Map<string, string>> {
  try {
    const file = await open(join(codexHomePath, "session_index.jsonl"), "r");
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of file.createReadStream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return parseCodexSessionIndexTitles(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    return new Map();
  }
}

function readRecordTimestampMs(record: ParsedJsonRecord, fallbackMs: number): number {
  if (typeof record.timestamp === "string") {
    const parsed = Date.parse(record.timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const payloadStartedAt = readNestedNumber(record.payload, ["started_at"]);
  if (payloadStartedAt !== null) {
    return normalizeEpochMs(payloadStartedAt);
  }

  const payloadCompletedAt = readNestedNumber(record.payload, ["completed_at"]);
  if (payloadCompletedAt !== null) {
    return normalizeEpochMs(payloadCompletedAt);
  }

  return fallbackMs;
}

function normalizeEpochMs(value: number): number {
  return value < 100_000_000_000 ? value * 1_000 : value;
}

function readNestedString(value: unknown, path: string[]): string | null {
  const nested = readNestedValue(value, path);
  return typeof nested === "string" && nested.trim() ? nested : null;
}

function readNestedNumber(value: unknown, path: string[]): number | null {
  const nested = readNestedValue(value, path);
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}

function readNestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
