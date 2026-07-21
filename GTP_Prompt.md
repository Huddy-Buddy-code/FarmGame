# Machine Sprite Prompts (Tractor / Combine, all 3 sizes)

Reference workflow: `src/ui/machineImages.ts`. Drop a correctly-named PNG into
`src/assets/Equipment/` and it's auto-discovered — no code change needed.

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
vignette/gradient backdrop as "close enough."

## Shared style (common to all 6)

- Semi-realistic 3D-rendered illustration (not flat vector, not photo) —
  matches the existing `Tractor_Medium_sideleft.png` reference: clean studio
  product-shot lighting, crisp specular highlights, subtle ambient occlusion
  under the machine, no cast shadow plane/floor.
- **Dead-on side profile view** (true elevation/orthographic side view, not a
  3/4 or hero angle) — the game rotates/mirrors this flat sprite in-engine, so
  perspective distortion or an off-axis camera breaks that.
- **Facing left** ("sideleft" — front of the machine toward the left edge of
  the frame). Never pre-mirror; the game flips it east with `scaleX` in code.
- Green body / yellow wheel rims / black tires, John-Deere-style livery — dark
  glass cab windows, visible cab ladder/steps, exhaust stack, front grille.
- Square canvas, machine filling ~80% of the frame width, centered, consistent
  ground line across all 6 images so the sizes read correctly relative to each
  other in-game (see per-size notes below).
- No text, logos, brand wordmarks, or watermarks anywhere on the machine.
- No people, no field/sky/horizon background elements of any kind.

---

## Tractors

Progression cue: small → large should visibly gain size, tire diameter, and
cab bulk — a small tractor is a light, low-profile utility machine; a large
tractor is a heavy row-crop unit with tall duals-capable rear tires.

### 1. `Tractor_Small_sideleft.png`

> Semi-realistic 3D-rendered farm tractor, dead-on side profile view, facing
> left. Compact utility tractor — low, light-framed, single rear wheels
> (no duals), smaller-diameter tires front and back, open visibility cab with
> narrow glass, short exhaust stack. Green body, yellow wheel rims, black
> tires, dark cab glass. Clean studio product-shot lighting, crisp specular
> highlights, subtle soft ambient occlusion directly under the tires only —
> no ground plane, no cast shadow stretching outward. Fully transparent PNG
> background (alpha channel, no vignette, no gradient backdrop). No text,
> logos, people, or scenery. Square canvas, machine centered, filling about
> 75% of the frame width.

### 2. `Tractor_Medium_sideleft.png`

> Semi-realistic 3D-rendered farm tractor, dead-on side profile view, facing
> left. Mid-size row-crop tractor — enclosed cab with full glass, visible
> cab-access ladder, taller rear tires than a compact model but not
> oversized, short exhaust stack ahead of the cab, front grille and headlamps.
> Green body, yellow wheel rims, black tires, dark cab glass. Clean studio
> product-shot lighting, crisp specular highlights, subtle soft ambient
> occlusion directly under the tires only — no ground plane, no cast shadow
> stretching outward. Fully transparent PNG background (alpha channel, no
> vignette, no gradient backdrop). No text, logos, people, or scenery. Square
> canvas, machine centered, filling about 80% of the frame width.

### 3. `Tractor_Large_sideleft.png`

> Semi-realistic 3D-rendered farm tractor, dead-on side profile view, facing
> left. Heavy-duty row-crop tractor — large enclosed cab, tall rear tires with
> visible dual-wheel capability (wide tread, substantial sidewall), a longer
> hood/engine bay than a mid-size unit, prominent exhaust stack, front
> weights/ballast visible on the nose. Green body, yellow wheel rims, black
> tires, dark cab glass. Clean studio product-shot lighting, crisp specular
> highlights, subtle soft ambient occlusion directly under the tires only —
> no ground plane, no cast shadow stretching outward. Fully transparent PNG
> background (alpha channel, no vignette, no gradient backdrop). No text,
> logos, people, or scenery. Square canvas, machine centered, filling about
> 85% of the frame width (largest of the three tractors).

---

## Combines

Progression cue: small → large should gain overall body size and a visibly
wider header/cutting platform at the front (small = narrow header, large =
wide header) — capacity and working width both scale up with size in-game.

### 4. `Combine_Small_sideleft.png`

> Semi-realistic 3D-rendered grain combine harvester, dead-on side profile
> view, facing left. Compact combine — smaller grain tank/hopper on top,
> narrower header/cutting platform at the front, shorter unloading auger,
> moderate-size drive wheels at the front and smaller steerable wheels at the
> rear. Green and yellow body panels, dark glass cab high up front, black
> tires. Clean studio product-shot lighting, crisp specular highlights,
> subtle soft ambient occlusion directly under the tires only — no ground
> plane, no cast shadow stretching outward. Fully transparent PNG background
> (alpha channel, no vignette, no gradient backdrop). No text, logos, people,
> or scenery. Square canvas, machine centered, filling about 80% of the frame
> width.

### 5. `Combine_Medium_sideleft.png`

> Semi-realistic 3D-rendered grain combine harvester, dead-on side profile
> view, facing left. Mid-size combine — larger grain tank/hopper on top than
> a compact model, wider header/cutting platform at the front, full-length
> unloading auger extended, large front drive wheels, smaller rear steering
> wheels. Green and yellow body panels, dark glass cab high up front, black
> tires. Clean studio product-shot lighting, crisp specular highlights,
> subtle soft ambient occlusion directly under the tires only — no ground
> plane, no cast shadow stretching outward. Fully transparent PNG background
> (alpha channel, no vignette, no gradient backdrop). No text, logos, people,
> or scenery. Square canvas, machine centered, filling about 85% of the frame
> width.

### 6. `Combine_Large_sideleft.png`

> Semi-realistic 3D-rendered grain combine harvester, dead-on side profile
> view, facing left. Large flagship combine — biggest grain tank/hopper of
> the lineup sitting high above the body, widest header/cutting platform at
> the front, long fully-extended unloading auger, oversized front drive
> wheels (wide tread, tall sidewall), smaller rear steering wheels. Green and
> yellow body panels, dark glass cab high up front, black tires. Clean studio
> product-shot lighting, crisp specular highlights, subtle soft ambient
> occlusion directly under the tires only — no ground plane, no cast shadow
> stretching outward. Fully transparent PNG background (alpha channel, no
> vignette, no gradient backdrop). No text, logos, people, or scenery. Square
> canvas, machine centered, filling about 90% of the frame width (largest of
> the three combines).

---

## After generating

1. Verify alpha transparency (open the PNG and confirm there's no dark box
   around the machine — check outside an image viewer that respects
   transparency, not just a browser tab with a white page background).
2. Save into `src/assets/Equipment/` with the exact filename from each
   section above.
3. No code change needed — `machineImageUrl` in `src/ui/machineImages.ts`
   picks them up automatically by filename at build time.
