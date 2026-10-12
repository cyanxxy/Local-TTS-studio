import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppFooter } from "./AppFooter";
import { BrowserSupportPanel } from "./BrowserSupportPanel";

describe("AppFooter", () => {
  it("lists the shipped runtimes as local badges", () => {
    render(<AppFooter runtimeBadges={["Kokoro", "Supertonic"]} note="unused" />);

    expect(screen.getByText("Kokoro")).toBeInTheDocument();
    expect(screen.getByText("Supertonic")).toBeInTheDocument();
    expect(screen.getByText("all local")).toBeInTheDocument();
    expect(screen.queryByText("unused")).not.toBeInTheDocument();
  });

  it("shows the note when there are no badges to show", () => {
    render(<AppFooter runtimeBadges={null} note="Kokoro is unavailable in this browser." />);

    expect(screen.getByText("Kokoro is unavailable in this browser.")).toBeInTheDocument();
    expect(screen.queryByText("all local")).not.toBeInTheDocument();
  });
});

describe("BrowserSupportPanel", () => {
  it("explains the limited browser model set", () => {
    render(<BrowserSupportPanel message="Supertonic runs on iOS." />);

    expect(screen.getByRole("heading", { name: /limited set of models/ })).toBeInTheDocument();
    expect(screen.getByText("Supertonic runs on iOS.")).toBeInTheDocument();
  });
});
