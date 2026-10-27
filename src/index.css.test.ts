import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * index.css holds the design tokens and the global rules no component test
 * can see (jsdom has no cascade or layout). These checks pin the properties
 * that broke before: text contrast, theme first paint, focus on sliders, and
 * the scale of UI text.
 */
const css = readFileSync("src/index.css", "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`No rule for ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && --depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`Unclosed rule for ${selector}`);
}

function token(declarations: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(declarations);
  if (!match) throw new Error(`No ${name}`);
  return match[1];
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` laid over `backdrop` at `alpha`, as color-mix(... transparent) composites. */
function over(color: string, backdrop: string, alpha: number): string {
  const top = channels(color);
  const bottom = channels(backdrop);
  return `#${top.map((value, at) => Math.round(value * alpha + bottom[at] * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

const AA = 4.5;
const WHITE = "#ffffff";
const light = block("@theme");
const dark = block(':root[data-theme="dark"]');
const ACCENT_SELECTORS = ['violet', 'teal', 'orange'].map((accent) => `:root[data-accent="${accent}"]`);
const DARK_ACCENT_SELECTORS = ['blue', 'violet', 'teal', 'orange'].map((accent) => `:root[data-theme="dark"][data-accent="${accent}"]`);

describe("index.css colour tokens (U4/U5)", () => {
  const panel = token(light, "--color-panel");
  const surface = token(light, "--color-surface");
  const darkPanel = token(dark, "--color-panel");
  const darkSurface = token(dark, "--color-surface");

  it.each(["--color-text-primary", "--color-text-secondary", "--color-text-muted", "--color-accent", "--color-danger", "--color-success", "--color-warning"])(
    "light %s reads at AA on the panel and the surface",
    (name) => {
      const color = token(light, name);
      expect(contrast(color, panel)).toBeGreaterThanOrEqual(AA);
      expect(contrast(color, surface)).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(["--color-accent", "--color-danger", "--color-success", "--color-warning"])(
    "light %s also reads on its own 10% tint (badges and chips)",
    (name) => {
      const color = token(light, name);
      expect(contrast(color, over(color, panel, 0.1))).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(["--color-text-primary", "--color-text-secondary", "--color-text-muted", "--color-danger", "--color-success", "--color-warning"])(
    "dark %s reads at AA on the dark panel and surface",
    (name) => {
      const color = token(dark, name);
      expect(contrast(color, darkPanel)).toBeGreaterThanOrEqual(AA);
      expect(contrast(color, darkSurface)).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(ACCENT_SELECTORS)("light accent %s reads at AA as text", (selector) => {
    const accent = token(block(selector), "--color-accent");
    expect(contrast(accent, panel)).toBeGreaterThanOrEqual(AA);
    expect(contrast(accent, surface)).toBeGreaterThanOrEqual(AA);
  });

  it.each(DARK_ACCENT_SELECTORS)("dark accent %s reads at AA as text", (selector) => {
    expect(contrast(token(block(selector), "--color-accent"), darkPanel)).toBeGreaterThanOrEqual(AA);
  });

  it.each([":root", ...ACCENT_SELECTORS])("white text holds AA on the %s accent fill, solid and as 94% glass over white", (selector) => {
    const fill = token(selector === ":root" ? light : block(selector), "--color-accent-fill");
    expect(contrast(WHITE, fill)).toBeGreaterThanOrEqual(AA);
    expect(contrast(WHITE, over(fill, WHITE, 0.94))).toBeGreaterThanOrEqual(AA);
  });

  it("dark mode never redefines a fill to a colour white text cannot sit on", () => {
    expect(dark).not.toMatch(/--color-(accent|danger)-fill/);
    for (const selector of DARK_ACCENT_SELECTORS) expect(block(selector)).not.toMatch(/-fill/);
    expect(contrast(WHITE, token(light, "--color-danger-fill"))).toBeGreaterThanOrEqual(AA);
  });

  it("glass-accent paints with the fill token, not the text accent", () => {
    expect(block(".glass-accent")).toMatch(/background-color: color-mix\(in srgb, var\(--color-accent-fill\) 94%, transparent\)/);
  });
});

describe("index.css first paint (U7)", () => {
  it("follows prefers-color-scheme until the app sets data-theme", () => {
    const media = /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{([^}]*)\}/.exec(css);
    expect(media).not.toBeNull();
    const firstPaint = media![1];
    for (const name of ["--color-surface", "--color-panel", "--color-text-primary", "--color-text-muted"]) {
      expect(token(firstPaint, name)).toBe(token(dark, name));
    }
    expect(firstPaint).toMatch(/color-scheme: dark/);
  });

  it.each(["index.html", "desktop.html"])("%s lets the browser canvas follow the OS before CSS loads", (entry) => {
    expect(readFileSync(entry, "utf8")).toMatch(/<meta name="color-scheme" content="light dark" \/>/);
  });
});

describe("index.css macOS vibrancy (U6)", () => {
  it("washes the window in the app surface when the theme is chosen explicitly", () => {
    expect(block(':root.is-electron.is-mac:not([data-theme-preference="system"]) body'))
      .toMatch(/background-color: color-mix\(in srgb, var\(--color-surface\) 90%, transparent\)/);
  });
});

describe("index.css range inputs (U3)", () => {
  it("does not suppress the focus outline and rings the thumb on keyboard focus", () => {
    expect(block('input[type="range"]')).not.toMatch(/outline:\s*none/);
    expect(block('input[type="range"]:focus-visible')).toMatch(/outline: 2px solid/);
    expect(block('input[type="range"]:focus-visible::-webkit-slider-thumb')).toMatch(/0 0 0 4px/);
    expect(block('input[type="range"]:focus-visible::-moz-range-thumb')).toMatch(/0 0 0 4px/);
  });
});

describe("index.css type scale (U8)", () => {
  it("sizes UI text in rem so Interface size scales it, at the same pixels by default", () => {
    const expected: Record<string, number> = { "2xs": 9, xs: 10, sm: 11, base: 13, lg: 14, xl: 16 };
    for (const [name, px] of Object.entries(expected)) {
      const match = new RegExp(`--text-${name}:\\s*([\\d.]+)rem;`).exec(light);
      expect(match, `--text-${name}`).not.toBeNull();
      expect(Number(match![1]) * 16).toBeCloseTo(px);
    }
  });
});

describe("index.css animations (U10)", () => {
  it("entrance animations leave no transform behind once they finish", () => {
    expect(css).toMatch(/--animate-fade-up: fade-up [^;]* backwards;/);
    expect(css).toMatch(/--animate-scale-in: scale-in [^;]* backwards;/);
  });

  it("has no endlessly repainting background-position stripe", () => {
    expect(css).not.toMatch(/background-position/);
    expect(css).not.toMatch(/progress-animated/);
  });
});

describe("component borders", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) ? [path] : [];
    });
  }

  it("use the theme border token, which stays visible in dark mode, not black", () => {
    const offenders = sources("src/components").filter((path) => /\bborder-black\//.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
