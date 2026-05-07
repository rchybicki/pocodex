import { describe, expect, it } from "vitest";

import {
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
        path: SESSION_PATH,
      },
    );

    expect(activity).toMatchObject({
      active: true,
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
});
