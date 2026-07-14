import { describe, expect, it, vi } from "vitest";
import { assertSafeImportUrl, importRemoteDocument } from "./urlImport";

const publicResolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);

describe("urlImport", () => {
  it("rejects local and credential-bearing URLs", async () => {
    await expect(assertSafeImportUrl("http://127.0.0.1/private", publicResolver)).rejects.toThrow("Local-network");
    await expect(assertSafeImportUrl("http://localhost/private", publicResolver)).rejects.toThrow("Local-network");
    await expect(assertSafeImportUrl("https://user:pass@example.com", publicResolver)).rejects.toThrow("credentials");
  });

  it("rejects hostnames that resolve to private addresses", async () => {
    const privateResolver = vi.fn(async () => [{ address: "192.168.1.2", family: 4 }]);
    await expect(assertSafeImportUrl("https://example.com", privateResolver)).rejects.toThrow("Local-network");
  });

  it("rejects IPv6 private, documentation, and IPv4-mapped loopback addresses", async () => {
    await expect(assertSafeImportUrl("http://[fd00::1]/private", publicResolver)).rejects.toThrow("Local-network");
    await expect(assertSafeImportUrl("http://[2001:db8::1]/private", publicResolver)).rejects.toThrow("Local-network");
    await expect(assertSafeImportUrl("http://[::ffff:127.0.0.1]/private", publicResolver)).rejects.toThrow("Local-network");
  });

  it("validates redirects and imports public HTML", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 302, headers: new Headers({ location: "/article" }), body: new Uint8Array() })
      .mockResolvedValueOnce({ status: 200, body: new TextEncoder().encode("<html><article>Local reader</article></html>"),
        headers: new Headers({
          "content-type": "text/html",
        }) });
    const result = await importRemoteDocument("https://example.com/start", fetcher, publicResolver);
    expect(result.finalUrl).toBe("https://example.com/article");
    expect(result.html).toContain("Local reader");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toMatchObject({ address: "93.184.216.34", family: 4 });
    expect(fetcher.mock.calls[1][0].url.toString()).toBe("https://example.com/article");
  });

  it("rejects unsupported remote content types", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/pdf" }),
      body: new TextEncoder().encode("binary"),
    });
    await expect(importRemoteDocument("https://example.com/file", fetcher, publicResolver))
      .rejects.toThrow("Unsupported URL content type");
  });
});
