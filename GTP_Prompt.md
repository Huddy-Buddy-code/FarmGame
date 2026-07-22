# Machine & Implement Sprite Prompts (Tractor / Combine, all 3 sizes)

Reference workflow: `src/ui/machineImages.ts`. Drop a correctly-named PNG into
`src/assets/Equipment/` and it's auto-discovered — no code change needed. Same
filename/orientation contract applies to implements (plow, planter, etc.) when
those get generated art of their own — the shared style below isn't
tractor/combine-specific.

**Filename convention:** `<Kind>_<Size>_sideleft.png`, exact case-insensitive
match: `Tractor_Small_sideleft.png`, `Tractor_Medium_sideleft.png`,
`Tractor_Large_sideleft.png`, `Combine_Small_sideleft.png`,
`Combine_Medium_sideleft.png`, `Combine_Large_sideleft.png`.

## ⚠️ Non-negotiable: transparent background

The first test asset (`Tractor_Medium_sideleft.png`) came back with a dark
vignette baked in as part of the image instead of real alpha transparency —
it shows up as an opaque box floating over the map in-game. **Every prompt
below explicitly asks for a transparent PNG background; if the tool doesn't
support alpha output directly, generate on a solid flat color (e.g. pure
magenta or pure green) and key it out before saving** — don't accept a soft
vignette/gradient backdrop as "close enough." This still applies even though
the 2026-07-21 hero-angle reference has a dramatic near-black backdrop baked
in for showcase purposes — that backdrop must be removed/keyed out before the
asset is saved into `src/assets/Equipment/`; only the moody lighting on the
machine itself should carry over, not the backdrop.

## Shared style (common to all — machines and implements alike)

- **Photorealistic 3D render**, showroom/product-photography quality — not a
  flat vector illustration. Reference: the hero tractor shot approved
  2026-07-21 (green/yellow row-crop tractor, dramatic angle, deep near-black
  background). Crisp specular highlights on paint and glass, glossy tire
  sidewalls, sharp mechanical detail (bolts, vents, hydraulic lines) rather
  than a soft toy-like render.
- **3/4 front-left hero angle** — camera slightly above and forward of the
  machine, so both the front grille/nose AND the left side are visible (not a
  flat elevation/side-on view). Still reads as "facing left" for the
  `sideleft` filename/mirror convention below — the nose points toward the
  left/front of the frame, never toward the camera or the right edge.
- **Facing left** ("sideleft" — front of the machine oriented toward the left
  side of the frame, per the angle above). Never pre-mirror; the game flips it
  east with `scaleX` in code.
- Dramatic, moody studio lighting — strong key light raking across the body,
  deep shadow falloff, a near-black (not pure-black) gradient backdrop in the
  reference shot for contrast. Ambient occlusion under/between the tires.
- Green body / yellow wheel rims / black tires, John-Deere-style livery — dark
  glass cab windows, visible cab ladder/steps, exhaust stack, front grille.
- Square canvas, machine filling ~80-85% of the frame, centered, consistent
  scale/proportions across a size lineup (small/medium/large) so they read
  correctly relative to each other in-game.
- No text, logos, brand wordmarks, or watermarks anywhere on the machine.
- No people, no field/sky/horizon background elements of any kind.

---

## Tractors

Progression cue: small → large should visibly gain size, tire diameter, and
cab bulk — a small tractor is a light, low-profile utility machine; a large
tractor is a heavy row-crop unit with tall duals-capable rear tires.

### 1. `Tractor_Small_sideleft.png`

> Photorealistic 3D-rendered farm tractor, 3/4 front-left hero angle (camera
> slightly above and forward, front grille and left side both visible),
> facing left. Compact utility tractor — low, light-framed, single rear wheels
> (no duals), smaller-diameter tires front and back, open visibility cab with
> narrow glass, short exhaust stack. Green body, yellow wheel rims, black
> tires, dark cab glass. Dramatic moody studio lighting, strong key light
> raking across the body, crisp specular highlights, deep shadow falloff,
> ambient occlusion under and between the tires — no visible ground plane, no
> cast shadow stretching outward. Fully transparent PNG background (alpha
> channel, no vignette, no gradient backdrop). No text, logos, people, or
> scenery. Square canvas, machine centered, filling about 75% of the frame
> width.

### 2. `Tractor_Medium_sideleft.png`

> Photorealistic 3D-rendered farm tractor, 3/4 front-left hero angle (camera
> slightly above and forward, front grille and left side both visible),
> facing left. Mid-size row-crop tractor — enclosed cab with full glass,
> visible cab-access ladder, taller rear tires than a compact model but not
> oversized, short exhaust stack ahead of the cab, front grille and headlamps.
> Green body, yellow wheel rims, black tires, dark cab glass. Dramatic moody
> studio lighting, strong key light raking across the body, crisp specular
> highlights, deep shadow falloff, ambient occlusion under and between the
> tires — no visible ground plane, no cast shadow stretching outward. Fully
> transparent PNG background (alpha channel, no vignette, no gradient
> backdrop). No text, logos, people, or scenery. Square canvas, machine
> centered, filling about 80% of the frame width.

### 3. `Tractor_Large_sideleft.png`

> Photorealistic 3D-rendered farm tractor, 3/4 front-left hero angle (camera
> slightly above and forward, front grille and left side both visible),
> facing left. Heavy-duty row-crop tractor — large enclosed cab, tall rear
> tires with visible dual-wheel capability (wide tread, substantial sidewall),
> a longer hood/engine bay than a mid-size unit, prominent exhaust stack,
> front weights/ballast visible on the nose. Green body, yellow wheel rims,
> black tires, dark cab glass. Dramatic moody studio lighting, strong key
> light raking across the body, crisp specular highlights, deep shadow
> falloff, ambient occlusion under and between the tires — no visible ground
> plane, no cast shadow stretching outward. Fully transparent PNG background
> (alpha channel, no vignette, no gradient backdrop). No text, logos, people,
> or scenery. Square canvas, machine centered, filling about 85% of the frame
> width (largest of the three tractors).

---

## Combines

Progression cue: small → large should gain overall body size and a visibly
wider header/cutting platform at the front (small = narrow header, large =
wide header) — capacity and working width both scale up with size in-game.

### 4. `Combine_Small_sideleft.png`

> Photorealistic 3D-rendered grain combine harvester, 3/4 front-left hero angle
> (camera slightly above and forward, front header and left side both
> visible), facing left. Compact combine — smaller grain tank/hopper on top,
> narrower header/cutting platform at the front, shorter unloading auger,
> moderate-size drive wheels at the front and smaller steerable wheels at the
> rear. Green and yellow body panels, dark glass cab high up front, black
> tires. Dramatic moody studio lighting, strong key light raking across the
> body, crisp specular highlights, deep shadow falloff, ambient occlusion
> under and between the tires — no visible ground plane, no cast shadow
> stretching outward. Fully transparent PNG background (alpha channel, no
> vignette, no gradient backdrop). No text, logos, people, or scenery. Square
> canvas, machine centered, filling about 80% of the frame width.

### 5. `Combine_Medium_sideleft.png`

> Photorealistic 3D-rendered grain combine harvester, 3/4 front-left hero angle
> (camera slightly above and forward, front header and left side both
> visible), facing left. Mid-size combine — larger grain tank/hopper on top
> than a compact model, wider header/cutting platform at the front,
> full-length unloading auger extended, large front drive wheels, smaller
> rear steering wheels. Green and yellow body panels, dark glass cab high up
> front, black tires. Dramatic moody studio lighting, strong key light raking
> across the body, crisp specular highlights, deep shadow falloff, ambient
> occlusion under and between the tires — no visible ground plane, no cast
> shadow stretching outward. Fully transparent PNG background (alpha channel,
> no vignette, no gradient backdrop). No text, logos, people, or scenery.
> Square canvas, machine centered, filling about 85% of the frame width.

### 6. `Combine_Large_sideleft.png`

> Photorealistic 3D-rendered grain combine harvester, 3/4 front-left hero angle
> (camera slightly above and forward, front header and left side both
> visible), facing left. Large flagship combine — biggest grain tank/hopper of
> the lineup sitting high above the body, widest header/cutting platform at
> the front, long fully-extended unloading auger, oversized front drive
> wheels (wide tread, tall sidewall), smaller rear steering wheels. Green and
> yellow body panels, dark glass cab high up front, black tires. Dramatic
> moody studio lighting, strong key light raking across the body, crisp
> specular highlights, deep shadow falloff, ambient occlusion under and
> between the tires — no visible ground plane, no cast shadow stretching
> outward. Fully transparent PNG background (alpha channel, no vignette, no
> gradient backdrop). No text, logos, people, or scenery. Square canvas,
> machine centered, filling about 90% of the frame width (largest of the
> three combines).

---

## Implements

Trailed attachments, hitched behind a tractor — see `main.ts`'s map-marker
implement badge and `MINOR_IMPLEMENT_KINDS` for how these get composited
in-game. Only the sizes actually sold matter (check `gameConfig.equipment`
before generating a Small/Large — several implements in this game are
medium-only, in which case skip the size suffix entirely and save as
`<Kind>_sideleft.png`).

### `Baler_sideleft.png`

Only one size is sold (`gameConfig.equipment.bailer.medium`), so this is a
single size-agnostic file — no `_Medium_` in the filename.

> Photorealistic 3D-rendered round hay baler, 3/4 front-left hero angle
> (camera slightly above and forward, front pickup header and left side both
> visible), facing left, trailed implement (tongue/hitch at the front-left
> edge, no engine or cab of its own). Rounded rectangular bale-forming
> chamber/drum as the main body, a wide pickup reel with spring tines at the
> front feeding hay up into it, a rear tailgate seam visible (where it swings
> open to eject a finished bale), twine-wrap housing on top, single wide
> flotation tire on each side under the chamber. A freshly-ejected round bale
> (cylindrical, straw-gold, visible twine wrap lines) sitting just behind/below
> the tailgate, partially in frame, to read clearly as a baler and not a
> generic tank or spreader. Dark rust-red body panels (matching the game's
> implement palette — NOT the tractor's green), black tires, dark steel
> undercarriage and hitch tongue. Dramatic moody studio lighting, strong key
> light raking across the body, crisp specular highlights, deep shadow
> falloff, ambient occlusion under the chamber and around the tire — no
> visible ground plane, no cast shadow stretching outward. Fully transparent
> PNG background (alpha channel, no vignette, no gradient backdrop). No text,
> logos, people, or scenery. Square canvas, machine (plus the trailing bale)
> centered, filling about 75% of the frame width — leave it a little smaller
> than the tractors, since it's a trailed attachment, not the lead vehicle.

### `BaleTrailer_Small_sideleft.png` / `BaleTrailer_Medium_sideleft.png`

Two sizes sold (`gameConfig.equipment.baleTrailer`: small = 10-bale capacity,
medium = 20). Progression cue: medium should read as visibly longer/deeper
than small, carrying roughly double the bales, not just a bigger version of
the same load.

> Photorealistic 3D-rendered flat-deck bale trailer, 3/4 front-left hero angle
> (camera slightly above and forward, front hitch tongue and left side both
> visible), facing left, trailed implement (drawbar/tongue at the front-left
> edge, no engine or cab of its own). Low flat steel deck on tandem axles
> (two wheels per side visible), loaded with round hay bales (cylindrical,
> straw-gold, visible twine wrap lines) sitting in a single row across the
> deck — [SMALL: three bales, deck sized just long enough to carry them, a
> compact single-axle-reading trailer] [MEDIUM: five to six bales, a visibly
> longer deck, tandem axles clearly doing more work]. Dark steel-gray deck
> and frame with rust-red trim accents (matching the game's implement
> palette — NOT the tractor's green), black tires. Dramatic moody studio
> lighting, strong key light raking across the deck and bales, crisp
> specular highlights, deep shadow falloff, ambient occlusion under the deck
> and between the bales — no visible ground plane, no cast shadow stretching
> outward. Fully transparent PNG background (alpha channel, no vignette, no
> gradient backdrop). No text, logos, people, or scenery. Square canvas,
> trailer and load centered, filling about 80% of the frame width (medium)
> / 70% (small, since it's the shorter of the two).

### `Mower_Small_sideleft.png` / `Mower_Medium_sideleft.png`

Two sizes sold (`gameConfig.equipment.mower`: small = 10 ft cut, medium =
20 ft — large mirrors medium and is never offered). Progression cue: medium's
cutter bar should read as roughly double the length of small's, with visibly
more cutting discs strung along it. Deliberately green here, not the usual
implement red — maintainer request (2026-07-21) to match the tractor's
John-Deere-style livery instead of the red/rust convention used elsewhere.

> Photorealistic 3D-rendered disc hay mower, 3/4 front-left hero angle
> (camera slightly above and forward, hitch end and left side both visible),
> facing left, trailed implement (drawbar/hitch at the front-left edge, no
> engine or cab of its own). A long angled cutter bar extends out to the
> rear-right, carrying a row of round rotating cutting discs (steel-gray,
> visible mounting bolts) along its length, a low steel skid/guard shoe
> running beneath the bar, and a single transport wheel supporting the
> outer/far end of the bar. Green body and toolbar (John-Deere-style livery,
> matching the tractor — generic green, no manufacturer badges/logos/text),
> yellow accent trim, black tire, dark steel cutter discs and skid shoe.
> [SMALL: a compact, short cutter bar with about four to five discs] [MEDIUM:
> a noticeably longer cutter bar with seven to nine discs strung along it].
> Dramatic moody studio lighting, strong key light raking across the bar and
> discs, crisp specular highlights, deep shadow falloff, ambient occlusion
> under the bar and around the wheel — no visible ground plane, no cast
> shadow stretching outward. Fully transparent PNG background (alpha
> channel, no vignette, no gradient backdrop). No text, logos, people, or
> scenery. Square canvas, mower centered, filling about 80% of the frame
> width (medium) / 65% (small, since its bar is shorter).

---

## After generating

1. Verify alpha transparency (open the PNG and confirm there's no dark box
   around the machine — check outside an image viewer that respects
   transparency, not just a browser tab with a white page background).
2. Save into `src/assets/Equipment/` with the exact filename from each
   section above.
3. No code change needed — `machineImageUrl` in `src/ui/machineImages.ts`
   picks them up automatically by filename at build time.
