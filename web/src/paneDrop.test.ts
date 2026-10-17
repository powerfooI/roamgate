import { expect, test } from "bun:test";
import { nearestPaneSide } from "./paneDrop";

const rect = { left: 100, top: 50, width: 200, height: 100 };

test.each([
  [110, 100, "left"],
  [290, 100, "right"],
  [200, 55, "up"],
  [200, 145, "down"],
  // Wide panes split along the diagonals, not by absolute pixel distance.
  [130, 60, "up"],
  [120, 70, "left"],
] as const)("(%d, %d) drops on the %s side", (x, y, side) => {
  expect(nearestPaneSide(rect, x, y)).toBe(side);
});

test("points outside the pane clamp to the nearest side", () => {
  expect(nearestPaneSide(rect, 40, 100)).toBe("left");
  expect(nearestPaneSide(rect, 200, 400)).toBe("down");
});
