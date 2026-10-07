import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DurationSlider } from "./DurationSlider";

const PRESETS = [30, 60, 120, 180, 240, 300, 360] as const;

function renderSlider(initial = 180) {
  const setDuration = vi.fn();

  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <DurationSlider
        value={value}
        onChange={(seconds) => {
          setDuration(seconds);
          setValue(seconds);
        }}
      />
    );
  }

  render(<Harness />);
  return {
    setDuration,
    input: () => screen.getByRole("spinbutton", { name: "Track Length (Seconds)" }),
  };
}

describe("DurationSlider", () => {
  it("renders Track Length and displays the duration", () => {
    const { input } = renderSlider(180);

    expect(screen.getByText(/track length/i)).toBeInTheDocument();
    expect(input()).toHaveValue(180);
    expect(screen.getByRole("slider", { name: "Track length slider" })).toHaveValue("180");
  });

  it("calls setDuration from the 30, 60, 120, 180, 240, 300, and 360 pills", async () => {
    const user = userEvent.setup();
    const { setDuration, input } = renderSlider(45);

    for (const seconds of PRESETS) {
      await user.click(screen.getByRole("button", { name: `${seconds}s` }));
      expect(setDuration).toHaveBeenLastCalledWith(seconds);
      expect(input()).toHaveValue(seconds);
    }
  });

  it("calls setDuration from the number input and clamps to the 30–360 range", () => {
    const { setDuration, input } = renderSlider(180);

    fireEvent.change(input(), { target: { value: "12" } });
    expect(setDuration).toHaveBeenLastCalledWith(30);
    expect(input()).toHaveValue(30);

    fireEvent.change(input(), { target: { value: "999" } });
    expect(setDuration).toHaveBeenLastCalledWith(360);
    expect(input()).toHaveValue(360);

    fireEvent.change(input(), { target: { value: "125" } });
    expect(setDuration).toHaveBeenLastCalledWith(125);
    expect(input()).toHaveValue(125);
  });
});
