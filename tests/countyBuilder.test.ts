import { describe, it, expect } from "vitest";
import {
  buildCountyManifest,
  zoomForBbox,
  fetchOverpass,
  CountyBuildError,
  NAIP_IMAGE_SERVER,
} from "../src/county/builder";
import type { CountyIndexEntry } from "../src/county/countyIndex";

const lancaster: CountyIndexEntry = {
  id: "lancaster-pa",
  fips: "42071",
  name: "Lancaster County",
  state: "PA",
  bbox: [-76.7256, 39.7198, -75.8698, 40.2679],
  center: [-76.2977, 39.9939],
};

describe("buildCountyManifest", () => {
  const m = buildCountyManifest(lancaster);

  it("derives the UTM zone from the center longitude", () => {
    expect(m.utm).toEqual({ zone: 18, hemisphere: "N" });
  });

  it("passes identity + geometry through and fills the shared NAIP source", () => {
    expect(m.id).toBe("lancaster-pa");
    expect(m.fips).toBe("42071");
    expect(m.bbox).toEqual(lancaster.bbox);
    expect(m.center).toEqual(lancaster.center);
    expect(m.imagery.imageServer).toBe(NAIP_IMAGE_SERVER);
    expect(m.roads.attribution).toContain("OpenStreetMap");
  });
});

describe("zoomForBbox", () => {
  it("gives Story County's bbox a close-in zoom", () => {
    expect(zoomForBbox([-93.7, 41.86, -93.32, 42.11])).toBe(11);
  });
  it("is monotonic: bigger county, smaller (or equal) zoom", () => {
    const small = zoomForBbox([-93.7, 41.86, -93.32, 42.11]);
    const big = zoomForBbox([-117.8, 33.87, -114.13, 35.81]); // San Bernardino
    expect(big).toBeLessThanOrEqual(small);
  });
  it("clamps to [9, 12] at both extremes", () => {
    expect(zoomForBbox([-100, 40, -99.95, 40.04])).toBe(12); // tiny
    expect(zoomForBbox([-120, 30, -100, 45])).toBe(9); // absurdly huge
  });
});

describe("fetchOverpass mirror fallback (injected fetch, no network)", () => {
  const okJson = { elements: [] };
  const okResponse = () => new Response(JSON.stringify(okJson));

  it("returns the first mirror's payload when it succeeds", async () => {
    const calls: string[] = [];
    const result = await fetchOverpass("QUERY", {
      mirrors: ["https://a/", "https://b/"],
      pauseMs: 0,
      fetchFn: async (url) => {
        calls.push(String(url));
        return okResponse();
      },
    });
    expect(result).toEqual(okJson);
    expect(calls).toEqual(["https://a/"]);
  });

  it("falls through to the second mirror when the first rejects", async () => {
    const calls: string[] = [];
    const result = await fetchOverpass("QUERY", {
      mirrors: ["https://a/", "https://b/"],
      pauseMs: 0,
      fetchFn: async (url) => {
        calls.push(String(url));
        if (String(url) === "https://a/") throw new Error("connection refused");
        return okResponse();
      },
    });
    expect(result).toEqual(okJson);
    expect(calls).toEqual(["https://a/", "https://b/"]);
  });

  it("treats a non-OK status (429) as a failure and moves on", async () => {
    const calls: string[] = [];
    const result = await fetchOverpass("QUERY", {
      mirrors: ["https://a/", "https://b/"],
      pauseMs: 0,
      fetchFn: async (url) => {
        calls.push(String(url));
        if (String(url) === "https://a/") return new Response("busy", { status: 429 });
        return okResponse();
      },
    });
    expect(result).toEqual(okJson);
    expect(calls).toEqual(["https://a/", "https://b/"]);
  });

  it("throws CountyBuildError naming every mirror when all fail", async () => {
    const err = await fetchOverpass("QUERY", {
      mirrors: ["https://a/", "https://b/"],
      pauseMs: 0,
      fetchFn: async () => {
        throw new Error("offline");
      },
    }).then(
      () => null,
      (e) => e as CountyBuildError,
    );
    expect(err).toBeInstanceOf(CountyBuildError);
    expect(err!.attempts.map((a) => a.mirror)).toEqual(["https://a/", "https://b/"]);
    expect(err!.attempts.every((a) => a.reason.includes("offline"))).toBe(true);
  });

  it("POSTs the query form-encoded", async () => {
    let seenBody = "";
    await fetchOverpass("way[highway];out;", {
      mirrors: ["https://a/"],
      pauseMs: 0,
      fetchFn: async (_url, init) => {
        seenBody = String(init?.body);
        return okResponse();
      },
    });
    expect(seenBody).toBe("data=" + encodeURIComponent("way[highway];out;"));
  });

  it("reports download progress with a growing byte count", async () => {
    const stages: string[] = [];
    let lastBytes = 0;
    await fetchOverpass("QUERY", {
      mirrors: ["https://a/"],
      pauseMs: 0,
      onProgress: (stage, d) => {
        stages.push(stage);
        if (d?.bytes) lastBytes = d.bytes;
      },
      fetchFn: async () => okResponse(),
    });
    expect(stages[0]).toBe("query");
    expect(stages).toContain("parse");
    expect(lastBytes).toBe(JSON.stringify(okJson).length);
  });
});
