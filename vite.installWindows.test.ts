import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* scripts/install-windows.ps1 cannot run outside Windows, and Windows CI runs it end to end
   (.github/workflows/rust-bridge.yml). These checks keep the parts that would only fail on a
   user's machine, or only on Windows PowerShell 5.1, from drifting in the meantime. */
const script = fs.readFileSync(path.resolve("scripts/install-windows.ps1"), "utf-8");
const workflow = fs.readFileSync(path.resolve(".github/workflows/rust-bridge.yml"), "utf-8");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8")) as {
  build: { nsis: { oneClick?: boolean; perMachine?: boolean } };
};
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("Windows installer script", () => {
  // Windows PowerShell 5.1 reads a .ps1 without a byte order mark as the ANSI code page.
  it("is plain ASCII", () => {
    const nonAscii = [...script].filter((char) => char > "\x7e" || (char < " " && !"\t\r\n".includes(char)));
    expect(nonAscii).toEqual([]);
  });

  it("avoids syntax that only PowerShell 7 understands", () => {
    expect(code).not.toMatch(/\?\?|\?\.|&&|\|\|/);
    expect(code).not.toMatch(/^\s*param\(/m);
  });

  it("pins the same LibTorch archive and digest as Windows CI", () => {
    const url = /\$LibtorchUrl = '([^']+)'/.exec(script)?.[1];
    const digest = /\$LibtorchSha256 = '([0-9a-f]{64})'/.exec(script)?.[1];
    expect(url).toBeDefined();
    expect(digest).toBeDefined();
    expect(workflow).toContain(url);
    expect(workflow).toContain(digest);
  });

  // npm.ps1 beside npm.cmd is a script file, which the default Restricted execution policy blocks.
  it("calls npm and npx through their .cmd shims", () => {
    const invocation = /(?:&\s*|Invoke-Native\s+|^\s*)['"]?np[mx](?:\.ps1)?['"]?\s/m;
    expect(code).not.toMatch(invocation);
    expect(code).toContain("npm.cmd");
    expect(code).toContain("npx.cmd");
  });

  it("checks the same desktop prerequisites as setup:desktop before building", () => {
    expect(code).toContain("'scripts/setup.mjs', '--desktop', '--check'");
    expect(code).toContain("Microsoft.VisualStudio.Workload.VCTools");
    expect(code).toContain("Microsoft.VisualStudio.Component.VC.Llvm.Clang");
  });

  // `/currentuser` is read only by electron-builder's assisted (non one-click) NSIS installer.
  it("installs per user through the assisted NSIS installer", () => {
    expect(code).toContain("'/S /currentuser'");
    expect(packageJson.build.nsis.oneClick).toBe(false);
    expect(packageJson.build.nsis.perMachine ?? false).toBe(false);
  });

  it("is exercised end to end by Windows CI under Windows PowerShell", () => {
    expect(workflow).toContain("scripts\\install-windows.ps1 -Check -Source .");
    expect(workflow).toContain("scripts\\install-windows.ps1 -Source .");
  });
});
