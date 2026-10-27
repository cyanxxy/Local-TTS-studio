// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  findLiteParseConverters,
  parseProcessList,
  stopLiteParseConverters,
  type ProcessEntry,
} from "./documentConverterProcesses";

const APP = 100;
const CONVERT = "--headless --invisible --convert-to pdf --outdir /tmp/liteparse-mRGnTf /home/me/slides.pptx";

function entry(pid: number, ppid: number, command: string): ProcessEntry {
  return { pid, ppid, command };
}

describe("parseProcessList", () => {
  it("reads ps and PowerShell lines, keeping the whole command line", () => {
    const output = [
      "    1     0 /sbin/init splash",
      "  200   100 /usr/lib/libreoffice/program/oosplash -env:UserInstallation=file:///tmp/liteparse-lo-profile-Q3pRpN --headless",
      "4 0 ",
      "",
      "not a process line",
    ].join("\r\n");

    expect(parseProcessList(output)).toEqual([
      entry(1, 0, "/sbin/init splash"),
      entry(200, 100, "/usr/lib/libreoffice/program/oosplash -env:UserInstallation=file:///tmp/liteparse-lo-profile-Q3pRpN --headless"),
      entry(4, 0, ""),
    ]);
  });
});

describe("findLiteParseConverters", () => {
  it("finds the conversion this process started, through its launcher", () => {
    const processes = [
      entry(APP, 1, "/Applications/Open TTS.app/Contents/MacOS/Open TTS"),
      entry(200, APP, `/usr/lib/libreoffice/program/oosplash -env:UserInstallation=file:///tmp/liteparse-lo-profile-Q3pRpN ${CONVERT}`),
      entry(201, 200, `/usr/lib/libreoffice/program/soffice.bin -env:UserInstallation=file:///tmp/liteparse-lo-profile-Q3pRpN ${CONVERT}`),
    ];

    expect(findLiteParseConverters(processes, APP).sort()).toEqual([200, 201]);
  });

  it("leaves this process's other children and other apps' conversions alone", () => {
    const processes = [
      entry(APP, 1, "Open TTS"),
      // The Rust bridge, an Electron helper, and the user's own LibreOffice.
      entry(300, APP, "/opt/Open TTS/resources/dist-rust/local-tts-bridge --port 0"),
      entry(301, APP, "/opt/Open TTS/open-tts --type=utility --utility-sub-type=network.mojom.NetworkService"),
      entry(400, 1, "/usr/lib/libreoffice/program/soffice.bin --writer /home/me/letter.odt"),
      // Another program's LiteParse conversion, with a profile of its own.
      entry(500, 499, `/usr/lib/libreoffice/program/soffice.bin -env:UserInstallation=file:///tmp/liteparse-lo-profile-OTHER1 ${CONVERT}`),
    ];

    expect(findLiteParseConverters(processes, APP)).toEqual([]);
  });

  it("still finds a converter that was reparented when its launcher exited", () => {
    const processes = [
      entry(APP, 1, "Open TTS"),
      entry(200, APP, `C:\\Program Files\\LibreOffice\\program\\soffice.exe -env:UserInstallation=file:///C:/Users/me/AppData/Local/Temp/liteparse-lo-profile-Ab12Cd ${CONVERT}`),
      entry(201, 4, `C:\\Program Files\\LibreOffice\\program\\soffice.bin -env:UserInstallation=file:///C:/Users/me/AppData/Local/Temp/liteparse-lo-profile-Ab12Cd ${CONVERT}`),
    ];

    expect(findLiteParseConverters(processes, APP).sort()).toEqual([200, 201]);
  });
});

describe("stopLiteParseConverters", () => {
  it("kills each converter, carrying on past one that already exited", async () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 200) throw new Error("ESRCH");
    });
    const list = async () => [
      entry(APP, 1, "Open TTS"),
      entry(200, APP, "soffice -env:UserInstallation=file:///tmp/liteparse-lo-profile-Q3pRpN"),
      entry(201, 200, "soffice.bin -env:UserInstallation=file:///tmp/liteparse-lo-profile-Q3pRpN"),
    ];

    await expect(stopLiteParseConverters({ rootPid: APP, list, kill })).resolves.toEqual([200, 201]);
    expect(kill.mock.calls).toEqual([[200], [201]]);
  });

  it("lists this machine's processes when not given a listing", async () => {
    // No converter runs under the test process, so nothing is signalled; this
    // only proves the platform listing runs and parses.
    await expect(stopLiteParseConverters({ kill: () => { throw new Error("must not kill"); } })).resolves.toEqual([]);
  });
});
