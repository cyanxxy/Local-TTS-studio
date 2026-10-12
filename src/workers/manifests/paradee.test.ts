import { describe, expect, it } from "vitest";
import { PARADEE_ASSETS } from "./paradee";

describe("Paradee asset manifest", () => {
  it("pins a full commit under a permissive license", () => {
    expect(PARADEE_ASSETS.repo).toBe("sahilmahendrakar/Paradee-8M-v1.0");
    expect(PARADEE_ASSETS.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(PARADEE_ASSETS.license).toBe("apache-2.0");
  });

  it("covers the int8 graph and the config", () => {
    expect(Object.keys(PARADEE_ASSETS.files).sort()).toEqual(["config.json", "onnx/paradee_int8.onnx"]);
  });
});
