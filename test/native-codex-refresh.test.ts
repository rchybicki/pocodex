import { describe, expect, it } from "vitest";

import {
  isNativeCodexRefreshEnabledByEnv,
  NativeCodexRefreshController,
  parseNativeCodexRefreshIntervalMs,
} from "../src/lib/native-codex-refresh.js";

const TARGET_THREAD_ID = "019e02ea-27b7-7071-b5de-4b5577ff2581";
const SECOND_THREAD_ID = "019e034d-ddf4-7193-9241-3a3446c0b5e4";
const PREVIOUS_THREAD_ID = "019e02dd-248b-7c71-9484-d77466be381e";

describe("NativeCodexRefreshController", () => {
  it("opens a changed thread in a Codex mini window and restores the previous thread", async () => {
    const commands: Array<{ args: string[]; file: string }> = [];
    const restoredClipboardValues: string[] = [];
    const clipboardReads = ["original clipboard", `codex://threads/${PREVIOUS_THREAD_ID}`];
    const controller = new NativeCodexRefreshController({
      commandTimeoutMs: 1_000,
      enabled: true,
      getClipboard: async () => clipboardReads.shift() ?? "",
      miniWindowCloseDelayMs: 0,
      openSettleMs: 0,
      platform: "darwin",
      refreshDelayMs: 0,
      runCommand: async (file, args) => {
        commands.push({ args, file });
        return {
          stderr: "",
          stdout: "",
        };
      },
      setClipboard: async (value) => {
        restoredClipboardValues.push(value);
      },
    });

    controller.queueThreadRefresh(TARGET_THREAD_ID, "test");
    await waitForCondition(() =>
      commands.some(
        (command) =>
          command.file === "/usr/bin/open" &&
          command.args[0] === `codex://threads/${PREVIOUS_THREAD_ID}`,
      ),
    );

    expect(commands).toEqual([
      {
        args: expect.arrayContaining(["-e", 'tell application "Codex" to activate']),
        file: "/usr/bin/osascript",
      },
      {
        args: [`codex://threads/${TARGET_THREAD_ID}`],
        file: "/usr/bin/open",
      },
      {
        args: expect.arrayContaining(["-e", '    keystroke "Open in Mini Window"']),
        file: "/usr/bin/osascript",
      },
      {
        args: [`codex://threads/${PREVIOUS_THREAD_ID}`],
        file: "/usr/bin/open",
      },
    ]);
    expect(restoredClipboardValues).toEqual(["original clipboard"]);

    controller.close();
  });

  it("ignores invalid thread IDs", async () => {
    const commands: Array<{ args: string[]; file: string }> = [];
    const controller = new NativeCodexRefreshController({
      enabled: true,
      platform: "darwin",
      refreshDelayMs: 0,
      runCommand: async (file, args) => {
        commands.push({ args, file });
        return {
          stderr: "",
          stdout: "",
        };
      },
    });

    controller.queueThreadRefresh("not-a-thread-id");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(commands).toEqual([]);
    controller.close();
  });

  it("rate limits repeated refreshes for the same thread", async () => {
    let now = 1_000;
    const openedThreads: string[] = [];
    const controller = new NativeCodexRefreshController({
      enabled: true,
      getClipboard: async () => "",
      minRefreshIntervalMs: 60_000,
      openSettleMs: 0,
      platform: "darwin",
      refreshDelayMs: 0,
      runCommand: async (file, args) => {
        if (file === "/usr/bin/open") {
          openedThreads.push(args[0] ?? "");
        }
        return {
          stderr: "",
          stdout: "",
        };
      },
      now: () => now,
    });

    controller.queueThreadRefresh(TARGET_THREAD_ID);
    await waitForCondition(() => openedThreads.length === 1);
    controller.queueThreadRefresh(TARGET_THREAD_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));

    now += 60_001;
    controller.queueThreadRefresh(TARGET_THREAD_ID);
    await waitForCondition(() => openedThreads.length === 2);

    expect(openedThreads).toEqual([
      `codex://threads/${TARGET_THREAD_ID}`,
      `codex://threads/${TARGET_THREAD_ID}`,
    ]);
    controller.close();
  });

  it("paces refreshes across different threads", async () => {
    const openedThreads: string[] = [];
    const controller = new NativeCodexRefreshController({
      enabled: true,
      getClipboard: async () => "",
      minRefreshIntervalMs: 40,
      openSettleMs: 0,
      platform: "darwin",
      refreshDelayMs: 0,
      runCommand: async (file, args) => {
        if (file === "/usr/bin/open") {
          openedThreads.push(args[0] ?? "");
        }
        return {
          stderr: "",
          stdout: "",
        };
      },
    });

    controller.queueThreadRefresh(TARGET_THREAD_ID);
    controller.queueThreadRefresh(SECOND_THREAD_ID);
    await waitForCondition(() => openedThreads.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(openedThreads).toEqual([`codex://threads/${TARGET_THREAD_ID}`]);

    await waitForCondition(() => openedThreads.length === 2);
    expect(openedThreads).toEqual([
      `codex://threads/${TARGET_THREAD_ID}`,
      `codex://threads/${SECOND_THREAD_ID}`,
    ]);
    controller.close();
  });
});

describe("native Codex refresh option parsing", () => {
  it("parses boolean environment values", () => {
    expect(isNativeCodexRefreshEnabledByEnv(undefined)).toBeNull();
    expect(isNativeCodexRefreshEnabledByEnv("true")).toBe(true);
    expect(isNativeCodexRefreshEnabledByEnv("0")).toBe(false);
    expect(isNativeCodexRefreshEnabledByEnv("wat")).toBeNull();
  });

  it("parses interval seconds as milliseconds", () => {
    expect(parseNativeCodexRefreshIntervalMs("60")).toBe(60_000);
    expect(parseNativeCodexRefreshIntervalMs("0")).toBeNull();
    expect(parseNativeCodexRefreshIntervalMs("nope")).toBeNull();
  });
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Condition did not become true in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
