import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, isAllowedAppUrl, isSafeExternalUrl, shouldGrantPermission } from "./security";

describe("isAllowedAppUrl", () => {
  it("allows the local dev server origin", () => {
    expect(isAllowedAppUrl("http://localhost:5173/studio")).toBe(true);
  });

  it("rejects the local dev server origin when dev trust is disabled", () => {
    expect(isAllowedAppUrl("http://localhost:5173/studio", { allowDevServer: false })).toBe(false);
  });

  it("allows the packaged app origin", () => {
    expect(isAllowedAppUrl("app://-/reader")).toBe(true);
  });

  it("rejects unrelated origins", () => {
    expect(isAllowedAppUrl("https://example.com")).toBe(false);
  });
});

describe("isSafeExternalUrl", () => {
  it("allows trusted https links", () => {
    expect(isSafeExternalUrl("https://github.com/neuphonic/neutts")).toBe(true);
    expect(isSafeExternalUrl("https://huggingface.co/neuphonic/neutts-nano")).toBe(true);
  });

  it("rejects non-https and unknown hosts", () => {
    expect(isSafeExternalUrl("http://github.com/neuphonic/neutts")).toBe(false);
    expect(isSafeExternalUrl("https://example.com")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("buildContentSecurityPolicy", () => {
  it("includes dev-only allowances when requested", () => {
    const policy = buildContentSecurityPolicy(true);
    expect(policy).toContain("http://localhost:5173");
    expect(policy).toContain("ws://localhost:5173");
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("'unsafe-inline'");
    const imgDirective = policy.split("; ").find((directive) => directive.startsWith("img-src"));
    expect(imgDirective?.split(/\s+/)).toContain("https:");
  });

  it("omits dev-only allowances in production mode", () => {
    const policy = buildContentSecurityPolicy(false);
    expect(policy).not.toContain("http://localhost:5173");
    expect(policy).not.toContain("ws://localhost:5173");
    const connectDirective = policy.split("; ").find((directive) => directive.startsWith("connect-src"));
    expect(connectDirective?.split(/\s+/)).not.toContain("https:");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).toContain("https://huggingface.co");
    expect(connectDirective?.split(/\s+/)).toContain("https://cas-bridge.xethub.hf.co");
  });

  it("does not allow arbitrary https image origins in production (no exfil beacon channel)", () => {
    const policy = buildContentSecurityPolicy(false);
    const imgDirective = policy.split("; ").find((directive) => directive.startsWith("img-src"));
    expect(imgDirective).toBe("img-src 'self' data: blob:");
    expect(imgDirective?.split(/\s+/)).not.toContain("https:");
  });

  it("denies renderer permission requests by default", () => {
    expect(shouldGrantPermission()).toBe(false);
  });
});
