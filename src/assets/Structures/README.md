# Structure sprites

Drop a correctly-named PNG here and the game uses it for that building
automatically — no code change. Until then the hand-drawn SVG in
`src/ui/structureIcons.ts` is used instead, so the map always renders
something.

## Naming

`<Kind>[_<Size>].png` — case-insensitive.

| Kind token      | Building        | Size token           |
| --------------- | --------------- | -------------------- |
| `Silo`          | Grain bin       | `Small`/`Medium`/`Large` (or omit for all tiers) |
| `BaleBarn`      | Hay barn        | omit                 |
| `BaleArea`      | Outdoor bale yard | omit               |
| `TractorBarn`   | Machine shed    | omit                 |
| `ImplementBarn` | Implement shed  | omit                 |
| `FarmYard`      | Farm yard       | omit                 |
| `SellPoint`     | Sell point      | omit                 |

Examples: `BaleBarn.png`, `Silo_Large.png`, `TractorBarn.png`.

## Art direction

Matches `ui/structureIcons.ts` so PNG and SVG are interchangeable:

- **Front/side elevation, viewed level** — not top-down, not isometric.
- **Base at the bottom edge of the image.** The sprite is anchored to the
  ground there, so empty space below the building makes it hover.
- **Transparent background, always.** It composites over satellite imagery; a
  baked-in backdrop shows as an opaque rectangle in the farmyard.
- **No brand logos or manufacturer trade dress.**
- The image's **width represents the real footprint width** (`structureWidthM`
  in `field/buildingRender.ts`) — that's what keeps a grain bin and a machine
  shed honestly proportioned against each other.
- No baked drop shadow — the CSS adds one, and a baked one double-darkens.

## Size on disk

**256×256**, like the machine sprites, and for the same reason: raw 1024 px
exports were 84% of the built payload before they were resized. Keep the
full-resolution original in `art-source/Structures/`. See the "Machine
sprites" section of `CLAUDE.md` for the full workflow, including the
pad-to-square-before-resize rule.
