import { describe, expect, it } from "vitest";
import { parseHfXetProgressLine } from "./hfXetDownload";

describe("parseHfXetProgressLine", () => {
  it("accepts bounded Xet progress events", () => {
    expect(parseHfXetProgressLine('{"downloadedBytes":25,"totalBytes":100}')).toEqual({
      downloadedBytes: 25,
      totalBytes: 100,
    });
    expect(parseHfXetProgressLine('{"downloadedBytes":125,"totalBytes":100}')).toEqual({
      downloadedBytes: 100,
      totalBytes: 100,
    });
  });

  it("ignores malformed diagnostic output", () => {
    expect(parseHfXetProgressLine("loading model")).toBeNull();
    expect(parseHfXetProgressLine('{"downloadedBytes":-1,"totalBytes":100}')).toBeNull();
    expect(parseHfXetProgressLine('{"downloadedBytes":1,"totalBytes":0}')).toBeNull();
  });
});
