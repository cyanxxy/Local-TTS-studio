import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SeedField } from "./SeedField";

/** Types `chars` one by one at the end of the field, as a user with the caret at the end would. */
function typeAtEnd(input: HTMLInputElement, chars: string) {
  for (const char of chars) fireEvent.change(input, { target: { value: input.value + char } });
}

function Harness() {
  const [seed, setSeed] = useState<number | null>(null);
  return (
    <>
      <SeedField seed={seed} onChange={setSeed} />
      <output aria-label="seed">{seed === null ? "random" : seed}</output>
    </>
  );
}

describe("SeedField", () => {
  it("keeps the seed when one digit too many is typed, instead of wiping it", () => {
    render(<Harness />);
    const input = screen.getByRole("spinbutton", { name: "Seed" }) as HTMLInputElement;
    typeAtEnd(input, "4294967295");
    expect(input.value).toBe("4294967295");
    typeAtEnd(input, "1");
    expect(input.value).toBe("4294967295");
    expect(screen.getByLabelText("seed")).toHaveTextContent("4294967295");
  });

  it("clears to a random seed when the field is emptied", () => {
    render(<Harness />);
    const input = screen.getByRole("spinbutton", { name: "Seed" }) as HTMLInputElement;
    typeAtEnd(input, "42");
    expect(screen.getByLabelText("seed")).toHaveTextContent("42");
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByLabelText("seed")).toHaveTextContent("random");
  });
});
