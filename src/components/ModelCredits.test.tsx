import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PIPER_VOICES } from "../lib/piperVoices";
import { ModelCredits } from "./ModelCredits";

describe("ModelCredits", () => {
  it("credits Kitten TTS, Paradee and Piper with their licences and sources", () => {
    render(<ModelCredits idPrefix="credits" />);

    const kitten = screen.getByRole("region", { name: "Kitten TTS" });
    expect(within(kitten).getByRole("link", { name: /Kitten TTS Nano 0\.8/ })).toHaveAttribute("href", expect.stringMatching(/^https:\/\/huggingface\.co\/KittenML\//));
    expect(kitten).toHaveTextContent("by KittenML");
    expect(kitten).toHaveTextContent("Apache-2.0");
    expect(kitten).toHaveTextContent("eSpeak NG");

    const paradee = screen.getByRole("region", { name: "Paradee" });
    expect(within(paradee).getByRole("link", { name: /Paradee-8M v1\.0/ })).toHaveAttribute("href", expect.stringContaining("Paradee-8M"));
    expect(paradee).toHaveTextContent("Apache-2.0");
    expect(paradee).toHaveTextContent("Distilled from Kokoro-82M");
  });

  it("credits every Piper voice's dataset and carries the CC BY 4.0 attribution for LibriTTS", () => {
    render(<ModelCredits idPrefix="credits" />);

    const piper = screen.getByRole("region", { name: "Piper" });
    for (const voice of PIPER_VOICES) expect(piper, voice.id).toHaveTextContent(voice.name);
    expect(within(piper).getByRole("link", { name: "CC-BY-4.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/",
    );
    const libritts = PIPER_VOICES.find((voice) => voice.id === "en_US-libritts-high")!;
    expect(piper).toHaveTextContent(libritts.attribution);
  });
});
