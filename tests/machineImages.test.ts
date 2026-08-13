/**
 * Sprite auto-discovery (`src/ui/machineImages.ts`) — filename IS the wiring, so
 * a typo in a filename is a silent art bug rather than a build error.
 *
 * This exists because of a specific mistake that has now happened twice: files
 * arriving with a DOUBLED extension, `Combine_Large_GrainHeader.png.png`. The
 * loader strips one `.png`, so the third token parses as `grainheader.png`,
 * which isn't a recognised variant — the entry then falls through to the
 * size-sprite branch and quietly OVERWRITES the plain `harvester|large` sprite
 * with the variant art. Nothing throws; the wrong combine just shows up
 * everywhere. The same thing happened to the Medium tractor in 2026-07-24.
 */

import { describe, it, expect } from "vitest";
import { machineImageUrl, machineVariantImageUrl } from "../src/ui/machineImages";

describe("size sprites resolve", () => {
  for (const size of ["small", "medium", "large"] as const) {
    it(`a ${size} combine has its own art`, () => {
      expect(machineImageUrl("harvester", size)).toBeTruthy();
    });
    it(`a ${size} tractor has its own art`, () => {
      expect(machineImageUrl("tractor", size)).toBeTruthy();
    });
  }

  it("accepts the `Combine` filename alias for the harvester kind", () => {
    expect(machineImageUrl("harvester", "large")).toBeTruthy();
  });

  it("both baler kinds have their own art, and it isn't the same picture", () => {
    // `Baler_sideleft.png` aliases onto the internal "bailer" spelling; the
    // square baler needs no alias. They're size-agnostic (only Medium is sold),
    // so this also covers the `<Kind>_sideleft.png` no-size form resolving for
    // every size column.
    const round = machineImageUrl("bailer", "medium");
    const square = machineImageUrl("squareBaler", "medium");
    expect(round).toBeTruthy();
    expect(square).toBeTruthy();
    expect(square).not.toBe(round);
    for (const size of ["small", "medium", "large"] as const) {
      expect(machineImageUrl("squareBaler", size), size).toBe(square);
    }
  });

  it("the windrower resolves without a size token", () => {
    expect(machineImageUrl("windrower", "large")).toBeTruthy();
    expect(machineImageUrl("windrower", "medium")).toBe(machineImageUrl("windrower", "large"));
  });

  it("every size sprite is a DISTINCT file — a doubled extension shows up here", () => {
    // If a variant file fell through to the size branch it would land on top of
    // one of these, making two sizes share a URL.
    const urls = (["small", "medium", "large"] as const).map((s) => machineImageUrl("harvester", s));
    expect(new Set(urls).size).toBe(3);
  });
});

describe("composite variants resolve, and stay OUT of the size registry", () => {
  it("the Large combine has grain-header art", () => {
    expect(machineVariantImageUrl("harvester", "large", "grainheader")).toBeTruthy();
  });

  it("that art did NOT overwrite the plain Large combine sprite", () => {
    // The whole point. `Combine_Large_GrainHeader.png.png` parsed as a size
    // sprite and replaced this one; the correctly-named file must not.
    const plain = machineImageUrl("harvester", "large");
    const variant = machineVariantImageUrl("harvester", "large", "grainheader");
    expect(plain).toBeTruthy();
    expect(variant).toBeTruthy();
    expect(variant).not.toBe(plain);
  });

  it("the Medium and Small combines have both header variants (2026-08-12)", () => {
    for (const size of ["medium", "small"] as const) {
      const plain = machineImageUrl("harvester", size);
      const grain = machineVariantImageUrl("harvester", size, "grainheader");
      const corn = machineVariantImageUrl("harvester", size, "cornheader");
      expect(plain).toBeTruthy();
      expect(grain).toBeTruthy();
      expect(corn).toBeTruthy();
      // Two distinct files (own URL each), but the corn head is a genuinely
      // different picture — unlike Large, where GrainHeader is the only
      // header variant that exists.
      expect(corn).not.toBe(grain);
    }
  });

  it("hay-spike variants still resolve for both tractor sizes", () => {
    for (const size of ["small", "medium"] as const) {
      expect(machineVariantImageUrl("tractor", size, "hayspike")).toBeTruthy();
      expect(machineVariantImageUrl("tractor", size, "hayspikebale")).toBeTruthy();
      // …and are different pictures from each other and from the plain tractor.
      const plain = machineImageUrl("tractor", size);
      const empty = machineVariantImageUrl("tractor", size, "hayspike");
      const loaded = machineVariantImageUrl("tractor", size, "hayspikebale");
      expect(new Set([plain, empty, loaded]).size).toBe(3);
    }
  });

  it("an unknown kind resolves to nothing rather than someone else's art", () => {
    expect(machineVariantImageUrl("nosuchmachine", "large", "grainheader")).toBeUndefined();
  });
});

describe("no sprite filename carries a doubled extension", () => {
  it("every discovered asset URL ends in exactly one .png", () => {
    // Belt and braces: catches the bad filename directly, whatever the parser
    // then decides to do with it. Vite hashes the basename into the URL, so a
    // `.png.png` source shows up as `…GrainHeader.png-<hash>.png`.
    const seen = [
      machineImageUrl("harvester", "large"),
      machineImageUrl("harvester", "medium"),
      machineImageUrl("harvester", "small"),
      machineImageUrl("tractor", "large"),
      machineVariantImageUrl("harvester", "large", "grainheader"),
      machineVariantImageUrl("tractor", "medium", "hayspike"),
    ].filter((u): u is string => !!u);
    expect(seen.length).toBeGreaterThan(0);
    for (const url of seen) {
      expect(url, url).not.toMatch(/\.png[^/]*\.png$/i);
    }
  });
});
