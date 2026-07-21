import { describe, it, expect } from "vitest";
import { drawFieldTexture } from "../src/field/fieldRender";
import type { Meters } from "../src/geo/coords";

/**
 * There's no canvas polyfill in this test environment (vitest runs in plain
 * node, no jsdom/`canvas` package — this repo has no pixel-level texture
 * tests to extend, per fieldRender.ts's doc comment). This is a minimal
 * no-op stand-in for the handful of CanvasRenderingContext2D calls
 * `drawFieldTexture` actually makes, just enough to exercise the code path
 * without throwing — not a rendering check.
 */
function fakeCtx(): CanvasRenderingContext2D {
  const ctx = {
    save() {}, restore() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, clip() {}, fill() {}, stroke() {},
    fillRect() {}, ellipse() {}, arc() {}, rotate() {}, translate() {},
    fillStyle: "", strokeStyle: "", globalAlpha: 1,
    globalCompositeOperation: "source-over", lineWidth: 1, lineJoin: "miter", lineCap: "butt",
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

// A 100 m x 100 m field, mapped 1:1 (meters == pixels) for simplicity.
const boundary: Meters[] = [[0, 0], [100, 0], [100, 100], [0, 100]];
const toPixel = (m: Meters): [number, number] => [m[0], m[1]];

describe("drawFieldTexture (headland framing smoke test)", () => {
  it("doesn't throw for a headland-framed status on a normal-sized field", () => {
    // "tilled" carries plow's 6-lap frame — the field is plenty big for all 6.
    expect(() =>
      drawFieldTexture(fakeCtx(), 100, 100, toPixel, boundary, { status: "tilled", seed: 1 }),
    ).not.toThrow();
  });

  it("doesn't throw when the field is too small for even one lap (degenerate fallback)", () => {
    const tiny: Meters[] = [[0, 0], [4, 0], [4, 4], [0, 4]];
    expect(() =>
      drawFieldTexture(fakeCtx(), 20, 20, (m) => m, tiny, { status: "tilled", seed: 1 }),
    ).not.toThrow();
  });

  it("doesn't throw for other headland-framed statuses (planted/harvested) or unframed ones (stubble/dormant)", () => {
    for (const p of [
      { status: "planted" as const, crop: "corn" as const },
      { status: "growing" as const, crop: "corn" as const, progress: 0.6 },
      { status: "harvested" as const, crop: "corn" as const },
      { status: "harvested" as const, crop: "grass" as const },
      { status: "stubble" as const },
      { status: "ready" as const, crop: "grass" as const, dormant: true },
    ]) {
      expect(() => drawFieldTexture(fakeCtx(), 100, 100, toPixel, boundary, { ...p, seed: 2 })).not.toThrow();
    }
  });
});
