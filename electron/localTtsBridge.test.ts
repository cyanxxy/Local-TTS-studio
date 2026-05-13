// @vitest-environment node

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PATH = path.join(ROOT_DIR, "python", "local_tts_bridge.py");
const NEUTTS_PYTHON = path.join(
  ROOT_DIR,
  ".venv-neutts",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const RESULT_PREFIX = "__RESULT__";
const PROGRESS_PREFIX = "__PROGRESS__";
const RUN_LOCAL_BRIDGE_TESTS = process.env.OPEN_TTS_RUN_LOCAL_BRIDGE_TESTS === "1"
  && fs.existsSync(NEUTTS_PYTHON);

function runNeuttsBridge(
  action: "probe" | "generate",
  payload: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "open-tts-bridge-"));
  try {
    return spawnSync(
      NEUTTS_PYTHON,
      [BRIDGE_PATH, "--action", action, "--model", "neutts", "--cache-dir", cacheDir],
      {
        encoding: "utf-8",
        env: {
          ...env,
          PYTHONIOENCODING: "utf-8",
        },
        input: JSON.stringify(payload),
      },
    );
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

function getResultPayload(stdout: string) {
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
  expect(resultLine).toBeTruthy();
  return JSON.parse(resultLine!.slice(RESULT_PREFIX.length)) as {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  };
}

describe("local_tts_bridge.py", () => {
  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("reports NeuTTS compatibility metadata during probe", () => {
    const completed = runNeuttsBridge("probe");

    expect(completed.status).toBe(0);
    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.result?.package).toBe("neutts");
    expect(typeof payload.result?.packageVersion).toBe("string");
    expect(["legacy_0_1_x", "current_1_2_x_or_newer"]).toContain(payload.result?.compatibilityMode);
  }, 15_000);

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("surfaces missing espeak-ng clearly when PATH is unavailable", () => {
    const completed = runNeuttsBridge("probe", {}, {
      ...process.env,
      PATH: "",
    });

    expect(completed.status).toBe(0);
    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.result?.ready).toBe(false);
    expect(String(payload.result?.message)).toMatch(/espeak-ng/i);
  });

  it.runIf(RUN_LOCAL_BRIDGE_TESTS)("emits progress before returning invalid reference audio errors", () => {
    const completed = runNeuttsBridge("generate", {
      text: "Generate this sample locally.",
      referenceText: "Reference transcript",
      referenceAudioBase64: "%%%not-base64%%%",
    });

    expect(completed.status).toBe(0);
    const progressLines = completed.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(PROGRESS_PREFIX))
      .map((line) => JSON.parse(line.slice(PROGRESS_PREFIX.length)) as { phase: string; message: string });

    expect(progressLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "runtime_check" }),
      ]),
    );

    const payload = getResultPayload(completed.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Reference audio is not valid base64-encoded WAV data.");
  });
});
