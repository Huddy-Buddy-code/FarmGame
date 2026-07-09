/**
 * Roads layer — renders the county's pre-built OSM road extract (brief §2, §9).
 *
 * Road geometry comes bundled in the county package (`roads.geojson`), so there is
 * NO live third-party call at play time — no Overpass rate limits or downtime. We
 * draw thin cased vector lines over the NAIP imagery (yellow = major road, white =
 * local), so the imagery stays clean (no land fill tinting it green).
 *
 * License: OSM data is ODbL — attribution required (brief §2, §13).
 */

import type { Map as MlMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";

/** Add the county road network as styled vector lines. `roads` is from the package. */
export function addRoadsLayer(map: MlMap, roads: FeatureCollection): void {
  map.addSource("roads", { type: "geojson", data: roads });

  // Dark casing under a lighter core so roads read on both bright fields and
  // dark tree lines. `major` (0/1) is precomputed in the extract.
  map.addLayer({
    id: "roads-casing",
    type: "line",
    source: "roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#1a1a1a",
      "line-opacity": 0.5,
      "line-width": ["interpolate", ["linear"], ["zoom"],
        10, ["case", ["==", ["get", "major"], 1], 2.5, 1],
        16, ["case", ["==", ["get", "major"], 1], 8, 4],
      ],
    },
  });
  map.addLayer({
    id: "roads-core",
    type: "line",
    source: "roads",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["==", ["get", "major"], 1], "#ffe36e", "#ffffff"],
      "line-opacity": 0.9,
      "line-width": ["interpolate", ["linear"], ["zoom"],
        10, ["case", ["==", ["get", "major"], 1], 1.2, 0.4],
        16, ["case", ["==", ["get", "major"], 1], 4, 2],
      ],
    },
  });
}
