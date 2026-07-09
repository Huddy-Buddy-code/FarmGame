/**
 * County registry + loader (brief §12).
 *
 * Lists the counties available to play and loads a county package by id from
 * `public/counties/<id>/`. Everything downstream (imagery, roads, coordinate
 * system) is driven by the loaded manifest, so shipping a new county is purely
 * a matter of adding a folder and one entry here.
 */

import type { CountyId, CountyManifest, CountyPackage } from "./types";
import type { FeatureCollection } from "geojson";

/** Counties shipped with the app. Add a line per new county package. */
export const COUNTIES: { id: CountyId; name: string }[] = [
  { id: "story-ia", name: "Story County, Iowa" },
];

function base(id: CountyId): string {
  return `${import.meta.env.BASE_URL}counties/${id}`;
}

/** Fetch and assemble a county package (manifest + data assets) by id. */
export async function loadCounty(id: CountyId): Promise<CountyPackage> {
  const root = base(id);

  const manifestRes = await fetch(`${root}/manifest.json`);
  if (!manifestRes.ok) {
    throw new Error(`County "${id}": manifest ${manifestRes.status}`);
  }
  const manifest = (await manifestRes.json()) as CountyManifest;

  const roadsRes = await fetch(`${root}/${manifest.roads.file}`);
  if (!roadsRes.ok) {
    throw new Error(`County "${id}": roads ${roadsRes.status}`);
  }
  const roads = (await roadsRes.json()) as FeatureCollection;

  return { manifest, roads };
}
