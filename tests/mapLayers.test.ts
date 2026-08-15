import { describe, it, expect } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { fieldLabelLayer } from "../src/field/fields";
import { baleSymbolLayer, ICON_PX } from "../src/field/baleLayer";

/**
 * Map layers are the one part of this codebase that fails INVISIBLY: a symbol
 * layer with a bad expression, a missing glyph stack, or a culled label draws
 * nothing and logs nothing. With Browser Preview off (maintainer directive),
 * nothing else would catch it — the "I only see 1 field label" bug on
 * 2026-07-30 shipped past a clean typecheck and 733 green tests.
 *
 * So: validate every layer spec against the real MapLibre style spec, and
 * assert the specific properties that decide whether anything appears.
 */

const SOURCE = "test-source";

/** Wrap a layer in the thinnest valid style so the spec validator can run. */
function styleWith(layer: LayerSpecification): StyleSpecification {
  return {
    version: 8,
    glyphs: "/fonts/{fontstack}/{range}.pbf",
    sources: {
      [SOURCE]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      [layer.source as string]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [layer],
  } as StyleSpecification;
}

function specErrors(layer: LayerSpecification): string[] {
  return validateStyleMin(styleWith(layer)).map((e) => `${e.message}`);
}

describe("field label layer", () => {
  const layer = fieldLabelLayer(SOURCE);

  it("is a valid MapLibre style layer", () => {
    expect(specErrors(layer)).toEqual([]);
  });

  it("renders EVERY field's label — overlap culling is off", () => {
    // The regression: `text-allow-overlap` defaults to FALSE, so labels on
    // adjacent fields collided and exactly one survived. `text-optional` does
    // NOT control this — it only governs dropping text from an icon+text pair,
    // so with no icon it was a no-op.
    const layout = layer.layout as Record<string, unknown>;
    expect(layout["text-allow-overlap"]).toBe(true);
    expect(layout["text-ignore-placement"]).toBe(true);
    expect(layout["text-optional"]).toBeUndefined();
  });

  it("is visible at the bundled county's default zoom (Story opens at 12)", () => {
    expect(layer.minzoom).toBeLessThanOrEqual(12);
  });

  it("names only the vendored font stack", () => {
    const fonts = (layer.layout as Record<string, unknown>)["text-font"] as string[];
    expect(fonts).toEqual(["Noto Sans Bold"]);
  });

  it("reads name and acres off the feature (the field-outlines source supplies both)", () => {
    const field = JSON.stringify((layer.layout as Record<string, unknown>)["text-field"]);
    expect(field).toContain('"name"');
    expect(field).toContain('"acres"');
  });

  it("has a halo, so labels stay legible over both bright stubble and dark tree lines", () => {
    const paint = layer.paint as Record<string, unknown>;
    expect(paint["text-halo-width"]).toBeGreaterThan(0);
    expect(paint["text-halo-color"]).toBeTruthy();
  });
});

describe("bale symbol layer", () => {
  const layer = baleSymbolLayer();

  it("is a valid MapLibre style layer", () => {
    expect(specErrors(layer)).toEqual([]);
  });

  it("draws every bale — no collision culling (the point of leaving DOM markers)", () => {
    const layout = layer.layout as Record<string, unknown>;
    expect(layout["icon-allow-overlap"]).toBe(true);
    expect(layout["icon-ignore-placement"]).toBe(true);
  });

  it("picks its icon per feature, so one layer serves every bale product", () => {
    expect((layer.layout as Record<string, unknown>)["icon-image"]).toEqual(["get", "product"]);
  });

  it("sits nudged up ~25% of its own height, not centered on the drop point", () => {
    // (2026-08-14, maintainer request). Negative Y = up, in icon-pixel units
    // (ICON_PX) so it scales automatically with the layer's icon-size stops.
    const layout = layer.layout as Record<string, unknown>;
    expect(layout["icon-offset"]).toEqual([0, -ICON_PX * 0.25]);
  });
});

describe("spec validation actually bites", () => {
  it("rejects a layer naming a property that isn't in the spec", () => {
    const broken = {
      ...fieldLabelLayer(SOURCE),
      layout: { ...(fieldLabelLayer(SOURCE).layout as object), "text-nonsense": true },
    } as LayerSpecification;
    expect(specErrors(broken).length).toBeGreaterThan(0);
  });

  it("rejects a malformed expression — the failure mode that renders nothing", () => {
    const broken = {
      ...fieldLabelLayer(SOURCE),
      layout: { ...(fieldLabelLayer(SOURCE).layout as object), "text-size": ["interpolate", ["linear"]] },
    } as LayerSpecification;
    expect(specErrors(broken).length).toBeGreaterThan(0);
  });
});
