import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { chunkForKokoroDetailed } from "../../lib/chunking";
import { ScriptPreflight, formatEstimate } from "./ScriptPreflight";

const chunkScript = (text: string) => chunkForKokoroDetailed(text, { backend: "wasm" });

function renderPreflight(overrides: Partial<React.ComponentProps<typeof ScriptPreflight>> = {}) {
  const props: React.ComponentProps<typeof ScriptPreflight> = {
    text: 'Dr. Smith paid $5.<break time="2s"/>GIF files are small. The end.',
    chunkScript,
    engineLabel: "Kokoro",
    rules: [{ from: "GIF", to: "jif" }],
    normalize: true,
    cleanup: false,
    pauseOverridesSec: { comma: 0.1, sentence: 0.2, paragraph: 0.3, none: 0 },
    speed: 1,
    ...overrides,
  };
  const view = render(<ScriptPreflight {...props} />);
  return { ...view, props };
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: /Script preflight/ }));
}

describe("formatEstimate", () => {
  it("formats minutes and hours", () => {
    expect(formatEstimate(0)).toBe("0:00");
    expect(formatEstimate(65.4)).toBe("1:05");
    expect(formatEstimate(3725)).toBe("1:02:05");
    expect(formatEstimate(-3)).toBe("0:00");
  });
});

describe("ScriptPreflight", () => {
  it("stays closed, and does no work, until opened", () => {
    renderPreflight();
    expect(screen.getByRole("button", { name: /Script preflight/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("preflight-duration")).not.toBeInTheDocument();
  });

  it("shows the estimate, the passage list and the pause map", () => {
    renderPreflight();
    open();

    expect(screen.getByTestId("preflight-duration")).toHaveTextContent(/^\d+:\d{2}$/);
    expect(screen.getByRole("img", { name: /Map of 2 passages/ })).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Doctor Smith paid five dollars.");
    expect(items[0]).toHaveTextContent("changed");
    expect(items[0]).toHaveTextContent("pause 2 s");
    expect(items[1]).toHaveTextContent("jif files are small. The end.");
    expect(items[1]).toHaveTextContent("changed");
    expect(screen.getByText(/2 of 2 passages are spoken differently/)).toBeInTheDocument();
    expect(screen.getByText(/An estimate for Kokoro/)).toBeInTheDocument();
  });

  it("shows the full spoken text on request", () => {
    renderPreflight();
    open();
    expect(screen.queryByTestId("preflight-spoken")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show the spoken text" }));
    expect(screen.getByTestId("preflight-spoken")).toHaveTextContent("jif files are small.");
  });

  it("marks only the passages that differ", () => {
    renderPreflight({ text: 'Plain words here.<break time="1s"/>GIF next.', normalize: false });
    open();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).not.toHaveTextContent("changed");
    expect(items[1]).toHaveTextContent("changed");
    expect(screen.getByText(/1 of 2 passages are spoken differently from how it is written/)).toBeInTheDocument();
  });

  it("says when nothing is rewritten", () => {
    renderPreflight({ text: "Nothing special here.", rules: [], normalize: false });
    open();
    expect(screen.getByText(/The script is spoken exactly as written/)).toBeInTheDocument();
  });

  it("speaks the single changed passage in the singular", () => {
    renderPreflight({ text: "Open GIF.", normalize: false });
    open();
    expect(screen.getByText(/1 of 1 passage is spoken differently from how it is written/)).toBeInTheDocument();
  });

  it("estimates a longer script at a slower speed", () => {
    const text = Array.from({ length: 20 }, () => "A sentence of reasonable length goes here.").join(" ");
    const { unmount } = renderPreflight({ text, speed: 1 });
    open();
    const normal = screen.getByTestId("preflight-duration").textContent;
    unmount();
    renderPreflight({ text, speed: 0.5 });
    open();
    const toSeconds = (value: string) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
    expect(toSeconds(screen.getByTestId("preflight-duration").textContent!)).toBeGreaterThan(toSeconds(normal!));
  });

  it("does not normalize languages without a normalizer", () => {
    renderPreflight({ speechLanguage: "fr" });
    open();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("Dr. Smith paid $5.");
  });

  it("cleans the script first when cleanup is on", () => {
    renderPreflight({ text: "Fact [1]. Another.", cleanup: true, rules: [], normalize: false });
    open();
    expect(screen.getAllByRole("listitem")[0]).not.toHaveTextContent("[1]");
  });

  it("shows an opening pause and asks for a script when there is none", () => {
    const { rerender, props } = renderPreflight({ text: '<break time="500ms"/>Hello there.' });
    open();
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(document.querySelector('[title="Opening pause 500 ms"]')).not.toBeNull();

    rerender(<ScriptPreflight {...props} text="   " />);
    expect(screen.getByText("Write or paste a script to preview it.")).toBeInTheDocument();
  });

  it("lists the first passages and the rest on request", () => {
    const text = Array.from({ length: 60 }, (_, index) => `Passage number ${index} stands alone.\n\n`).join("");
    renderPreflight({ text, rules: [], normalize: false });
    open();
    expect(screen.getAllByRole("listitem")).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: "Show all 60 passages" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });

  it("caps the map for very long scripts and marks automatic pauses apart from tags", () => {
    const text = Array.from({ length: 230 }, (_, index) => `Line ${index} of the script.\n\n`).join("");
    renderPreflight({ text, rules: [], normalize: false });
    open();
    expect(screen.getByText("The map shows the first 200 passages.")).toBeInTheDocument();
    expect(document.querySelectorAll('[title^="Pause 3"]').length).toBeGreaterThan(0);
  });
});
