import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CodexSessionActivityWatcher,
  extractConversationIdFromSessionPath,
  parseCodexSessionActivityJsonl,
  parseCodexSessionIndexTitles,
} from "../src/lib/codex-session-activity.js";

const SESSION_PATH =
  "/Users/test/.codex/sessions/2026/05/07/rollout-2026-05-07T12-02-29-019e01e3-877b-73a1-a51a-68717c50a0fa.jsonl";

describe("codex session activity", () => {
  it("extracts conversation IDs from Codex rollout session paths", () => {
    expect(extractConversationIdFromSessionPath(SESSION_PATH)).toBe(
      "019e01e3-877b-73a1-a51a-68717c50a0fa",
    );
  });

  it("marks a session active when the latest task has not completed", () => {
    const activity = parseCodexSessionActivityJsonl(
      [
        JSON.stringify({
          timestamp: "2026-05-07T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e01e3-877b-73a1-a51a-68717c50a0fa",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-07T12:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
      ].join("\n"),
      {
        fallbackUpdatedAtMs: Date.parse("2026-05-07T12:01:00.000Z"),
        nowMs: Date.parse("2026-05-07T12:01:01.000Z"),
        path: SESSION_PATH,
      },
    );

    expect(activity).toMatchObject({
      active: true,
      conversationId: "019e01e3-877b-73a1-a51a-68717c50a0fa",
    });
  });

  it("marks an incomplete session inactive after the session file goes stale", () => {
    const activity = parseCodexSessionActivityJsonl(
      [
        JSON.stringify({
          timestamp: "2026-05-07T12:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019e01e3-877b-73a1-a51a-68717c50a0fa",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-07T12:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
      ].join("\n"),
      {
        activeGraceMs: 5 * 60 * 1_000,
        fallbackUpdatedAtMs: Date.parse("2026-05-07T12:01:00.000Z"),
        nowMs: Date.parse("2026-05-07T12:07:00.000Z"),
        path: SESSION_PATH,
      },
    );

    expect(activity).toMatchObject({
      active: false,
      conversationId: "019e01e3-877b-73a1-a51a-68717c50a0fa",
    });
  });

  it("marks a session inactive when the latest task completed", () => {
    const activity = parseCodexSessionActivityJsonl(
      [
        JSON.stringify({
          timestamp: "2026-05-07T12:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-07T12:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-1",
          },
        }),
      ].join("\n"),
      {
        fallbackUpdatedAtMs: Date.parse("2026-05-07T12:02:00.000Z"),
        path: SESSION_PATH,
      },
    );

    expect(activity).toMatchObject({
      active: false,
      conversationId: "019e01e3-877b-73a1-a51a-68717c50a0fa",
    });
  });

  it("marks a session inactive when the latest task was aborted", () => {
    const activity = parseCodexSessionActivityJsonl(
      [
        JSON.stringify({
          timestamp: "2026-05-07T12:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-07T12:01:15.000Z",
          type: "event_msg",
          payload: {
            type: "turn_aborted",
            turn_id: "turn-1",
            reason: "interrupted",
          },
        }),
      ].join("\n"),
      {
        fallbackUpdatedAtMs: Date.parse("2026-05-07T12:01:15.000Z"),
        path: SESSION_PATH,
      },
    );

    expect(activity).toMatchObject({
      active: false,
      conversationId: "019e01e3-877b-73a1-a51a-68717c50a0fa",
    });
  });

  it("reads thread titles from Codex's session index", () => {
    const titles = parseCodexSessionIndexTitles(
      [
        JSON.stringify({
          id: "019e01e3-877b-73a1-a51a-68717c50a0fa",
          thread_name: "pocodex",
        }),
        "not json",
      ].join("\n"),
    );

    expect(titles.get("019e01e3-877b-73a1-a51a-68717c50a0fa")).toBe("pocodex");
  });

  it("expires a previously active snapshot even when the session file did not change", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pocodex-session-activity-"));
    const sessionDirectory = join(codexHome, "sessions", "2026", "05", "07");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionPath = join(
      sessionDirectory,
      "rollout-2026-05-07T12-02-29-019e01e3-877b-73a1-a51a-68717c50a0fa.jsonl",
    );
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-05-07T12:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
        },
      })}\n`,
      "utf8",
    );
    const staleDate = new Date(Date.now() - 10_000);
    await utimes(sessionPath, staleDate, staleDate);
    const sessionStat = await stat(sessionPath);
    const activities: Array<{ active: boolean; conversationId: string }> = [];
    const watcher = new CodexSessionActivityWatcher({
      activeGraceMs: 1,
      codexHomePath: codexHome,
      onActivity: (activity) => {
        activities.push({
          active: activity.active,
          conversationId: activity.conversationId,
        });
      },
    });
    const snapshotsByPath = Reflect.get(watcher, "snapshotsByPath") as Map<
      string,
      {
        active: boolean;
        conversationId: string;
        mtimeMs: number;
        path: string;
        size: number;
        title: string | null;
        updatedAtMs: number;
      }
    >;
    snapshotsByPath.set(sessionPath, {
      active: true,
      conversationId: "019e01e3-877b-73a1-a51a-68717c50a0fa",
      mtimeMs: sessionStat.mtimeMs,
      path: sessionPath,
      size: sessionStat.size,
      title: null,
      updatedAtMs: sessionStat.mtimeMs,
    });

    await watcher.pollNow();

    expect(activities).toEqual([
      {
        active: false,
        conversationId: "019e01e3-877b-73a1-a51a-68717c50a0fa",
      },
    ]);
  });
});
