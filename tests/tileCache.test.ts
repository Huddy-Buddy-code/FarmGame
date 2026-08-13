import { describe, it, expect } from "vitest";
import {
  WORLD_3857, TILE_MAXZOOM, tileKey, tileBbox3857, naipExportUrl, parseNaipTileUrl,
  memoryTileStore, configureNaipCache, loadTile, hasTile, naipProtocolHandler,
  DEFAULT_NAIP_PROVIDER, NAIP_PROVIDERS, naipProviderImageServer,
} from "../src/map/tileCache";

/** A fetch double that serves a unique payload per URL and counts calls. */
function countingFetch(): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(url);
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(url).buffer };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("tile math", () => {
  it("z0 is the whole web-mercator world", () => {
    expect(tileBbox3857({ z: 0, x: 0, y: 0 })).toEqual([-WORLD_3857, -WORLD_3857, WORLD_3857, WORLD_3857]);
  });

  it("z1 quadrants tile the world (XYZ: y=0 is north)", () => {
    expect(tileBbox3857({ z: 1, x: 0, y: 0 })).toEqual([-WORLD_3857, 0, 0, WORLD_3857]); // NW
    expect(tileBbox3857({ z: 1, x: 1, y: 1 })).toEqual([0, -WORLD_3857, WORLD_3857, 0]); // SE
  });

  it("adjacent tiles share edges exactly", () => {
    const a = tileBbox3857({ z: 13, x: 1963, y: 3003 });
    const b = tileBbox3857({ z: 13, x: 1964, y: 3003 });
    expect(b[0]).toBe(a[2]);
  });

  it("exportImage URL carries the tile bbox and the render params", () => {
    const url = naipExportUrl("https://example.com/ImageServer", { z: 1, x: 0, y: 0 });
    expect(url).toContain("https://example.com/ImageServer/exportImage?");
    expect(decodeURIComponent(url)).toContain(`bbox=${-WORLD_3857},0,0,${WORLD_3857}`);
    expect(url).toContain("bboxSR=3857");
    expect(url).toContain("size=256%2C256");
    expect(url).toContain("f=image");
  });

  it("naip:// URLs round-trip; junk is rejected", () => {
    expect(parseNaipTileUrl("naip://tile/usda-apfo/13/1963/3003")).toEqual({
      provider: "usda-apfo", z: 13, x: 1963, y: 3003,
    });
    expect(parseNaipTileUrl("naip://tile/13/1963/3003")).toBeNull(); // no provider segment
    expect(parseNaipTileUrl("naip://tile/usda-apfo/13/1963")).toBeNull();
    expect(parseNaipTileUrl("https://example.com/usda-apfo/13/1963/3003")).toBeNull();
    expect(parseNaipTileUrl("naip://tile/usda-apfo/a/b/c")).toBeNull();
  });

  it("maxzoom matches NAIP's real ~0.3m resolution, not the old ~1m assumption", () => {
    // 2026-08-12: querying the ImageServer's own catalog for a real source
    // raster returned resolution_value: 0.3 meters — confirmed via a
    // Laplacian-variance check that the server holds real extra detail past
    // the old z17 ceiling (see tileCache.ts's TILE_MAXZOOM comment).
    expect(TILE_MAXZOOM).toBe(18);
  });

  it("every registered provider resolves to its own imageServer, default first", () => {
    expect(NAIP_PROVIDERS.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_NAIP_PROVIDER).toBe(NAIP_PROVIDERS[0]!.id);
    const urls = new Set(NAIP_PROVIDERS.map((p) => naipProviderImageServer(p.id)));
    expect(urls.size).toBe(NAIP_PROVIDERS.length); // no two providers share a host
    expect(naipProviderImageServer("does-not-exist")).toBe(NAIP_PROVIDERS[0]!.imageServer); // safe fallback
  });
});

describe("naip cache", () => {
  it("fetches a miss once, then serves from the store forever", async () => {
    const { fetchFn, calls } = countingFetch();
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const t = { provider: DEFAULT_NAIP_PROVIDER, z: 13, x: 1963, y: 3003 };
    const first = await loadTile(t);
    const second = await loadTile(t);
    expect(calls).toHaveLength(1);
    expect(new Uint8Array(second)).toEqual(new Uint8Array(first));
    expect(await hasTile(t)).toBe(true);
  });

  it("invokes fetch UNBOUND — native window.fetch throws 'Illegal invocation' as a method call", async () => {
    // Regression (2026-07-28): loadTile called `config.fetchFn(url)`, invoking
    // fetch with `this === config` — every tile failed in the browser and the
    // map went black. This double enforces what native fetch enforces.
    const fetchFn = async function (this: unknown, url: string) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    } as unknown as typeof fetch;
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    await expect(loadTile({ provider: DEFAULT_NAIP_PROVIDER, z: 12, x: 3, y: 4 })).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
  });

  it("throws on HTTP failure with no cached copy (MapLibre shows a failed tile)", async () => {
    const fetchFn = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    await expect(loadTile({ provider: DEFAULT_NAIP_PROVIDER, z: 10, x: 1, y: 2 })).rejects.toThrow("HTTP 503");
  });

  it("protocol handler resolves a naip:// URL through the cache", async () => {
    const { fetchFn, calls } = countingFetch();
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const res = await naipProtocolHandler({ url: "naip://tile/usda-apfo/13/1963/3003" });
    expect(res.data.byteLength).toBeGreaterThan(0);
    expect(calls[0]).toContain("/exportImage?");
    await expect(naipProtocolHandler({ url: "naip://tile/nope" })).rejects.toThrow("bad url");
  });

  it("keys are one-per-tile", () => {
    expect(tileKey({ z: 13, x: 1963, y: 3003 })).toBe("13/1963/3003");
  });

  it("two providers at the same z/x/y never share a cache entry", async () => {
    // The whole point of putting provider in the cache key: USDA APFO and
    // USGS serve different bytes for the same tile coordinates (different
    // mosaic/year/compression). A shared key would silently serve one
    // provider's imagery while labeled as the other's.
    const { fetchFn, calls } = countingFetch();
    configureNaipCache({ fetchFn, store: memoryTileStore() });
    const a = { provider: "usda-apfo", z: 13, x: 1963, y: 3003 };
    const b = { provider: "usgs-naip", z: 13, x: 1963, y: 3003 };
    await loadTile(a);
    await loadTile(b);
    expect(calls).toHaveLength(2); // both actually hit the network — no false cache hit
    expect(calls[0]).not.toBe(calls[1]);
  });
});
