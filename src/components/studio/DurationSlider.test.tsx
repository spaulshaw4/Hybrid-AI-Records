import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DurationSlider, formatTrackTime } from "./DurationSlider";

const PRESETS = [
  [30, "30 sec"],
  [60, "1 min"],
  [90, "1 min 30 sec"],
  [120, "2 min"],
  [150, "2 min 30 sec"],
  [180, "3 min"],
  [210, "3 min 30 sec"],
  [240, "4 min"],
  [300, "5 min"],
  [360, "6 min"],
] as const;

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

describe("formatTrackTime", () => {
  it("labels whole minutes and leftover seconds", () => {
    expect(formatTrackTime(30)).toBe("30 sec");
    expect(formatTrackTime(60)).toBe("1 min");
    expect(formatTrackTime(90)).toBe("1 min 30 sec");
    expect(formatTrackTime(240)).toBe("4 min");
    expect(formatTrackTime(360)).toBe("6 min");
  });
});

describe("DurationSlider", () => {
  it("renders Track Length and displays the duration", () => {
    const { input } = renderSlider(180);

    expect(screen.getByText(/track length/i)).toBeInTheDocument();
    expect(screen.getByText("Length follows the lyric arrangement.")).toBeInTheDocument();
    expect(screen.getByText("3 min", { selector: "span" })).toBeInTheDocument();
    expect(input()).toHaveValue(180);
    expect(screen.getByRole("slider", { name: "Track length slider" })).toHaveValue("180");
  });

  it("calls setDuration from the human-labeled preset pills", async () => {
    const user = userEvent.setup();
    const { setDuration, input } = renderSlider(45);

    for (const [seconds, label] of PRESETS) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(setDuration).toHaveBeenLastCalledWith(seconds);
      expect(input()).toHaveValue(seconds);
      expect(screen.getByText(label, { selector: "span" })).toBeInTheDocument();
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
