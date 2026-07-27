/**
 * The home screen / main menu (2026-07-26) — shown EVERY launch, before the
 * map boots: pick a farm to play, or create a new one in any CONUS county.
 *
 * Contract with main.ts's boot():
 *   - `runHomeScreen()` resolves ONLY when the player picks the farm that is
 *     ALREADY active — the caller then proceeds straight into `main()`.
 *   - Every other choice (play another farm, create a farm, delete the active
 *     farm) flips localStorage state, sets the AUTOBOOT flag where boot should
 *     skip the menu, and reloads the page — the returned promise never
 *     settles, exactly like the Settings tab's Load buttons.
 *
 * Creating a farm is BUILD-FIRST: the county package is fetched/built (with
 * progress UI) while still in the menu, and the farm is only created once the
 * build succeeded — a failed Overpass fetch can never strand a farm whose
 * county won't load.
 */

import {
  listFarms, loadGameFor, createFarm, switchFarm, deleteFarm, ensureActiveFarm,
} from "../state/persistence";
import { farmSummaryLine } from "../state/farmSummary";
import { loadCountyIndex, type CountyIndexEntry } from "../county/countyIndex";
import { loadCounty, isBundled } from "../county/registry";
import { NAIP_IMAGE_SERVER, CountyBuildError, type BuildStage } from "../county/builder";

/** sessionStorage key: "boot straight into this farm id, skip the menu". */
export const AUTOBOOT_KEY = "farm-sim-autoboot";
/** sessionStorage hint: open the menu with the New Farm section expanded. */
export const MENU_OPEN_NEW_KEY = "farm-sim-menu-open-new";

export interface HomeScreenOptions {
  activeFarmId: string;
  /** A county-load failure from a previous boot attempt, shown on entry. */
  error?: string;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`home screen: #${id} missing`);
  return el;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** NAIP thumbnail for a county bbox — one exportImage call, no API key. */
function thumbUrl(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({
    bbox: `${w},${s},${e},${n}`,
    bboxSR: "4326",
    imageSR: "3857",
    size: "256,196",
    format: "jpg",
    f: "image",
  });
  return `${NAIP_IMAGE_SERVER}/exportImage?${params}`;
}

export function runHomeScreen(opts: HomeScreenOptions): Promise<void> {
  return new Promise((resolve) => {
    const screen = $("home-screen");
    screen.style.display = "flex";
    if (opts.error) showError(opts.error);

    // The index powers the county picker AND the farm rows' county labels.
    // Kicked off immediately; both consumers tolerate it failing (offline —
    // bundled/cached farms still boot fine without it).
    const indexPromise = loadCountyIndex().catch(() => null);

    // ---- farm list -------------------------------------------------------
    function renderFarms(): void {
      const rows = $("hs-farms");
      rows.innerHTML = "";
      for (const meta of listFarms()) {
        const isActive = meta.id === opts.activeFarmId;
        const row = document.createElement("div");
        row.className = "farm-row" + (isActive ? " active" : "");
        row.innerHTML = `
          <span class="icon">🚜</span>
          <span class="farm-info">
            <div class="farm-name">${escapeHtml(meta.name)}</div>
            <div class="farm-sub">${farmSummaryLine(loadGameFor(meta.id))} · <span data-county="${escapeHtml(meta.countyId)}">${escapeHtml(meta.countyId)}</span></div>
          </span>`;

        const playBtn = document.createElement("button");
        playBtn.className = "primary";
        playBtn.textContent = "▶ Play";
        playBtn.addEventListener("click", () => {
          if (isActive) {
            // The boot path already loaded this farm's save — just proceed.
            screen.style.display = "none";
            resolve();
            return;
          }
          sessionStorage.setItem(AUTOBOOT_KEY, meta.id);
          switchFarm(meta.id);
          location.reload();
        });
        row.appendChild(playBtn);

        const delBtn = document.createElement("button");
        delBtn.className = "farm-del";
        delBtn.textContent = "🗑";
        delBtn.title = `Delete ${meta.name}`;
        delBtn.addEventListener("click", () => {
          if (!confirm(`Delete "${meta.name}"? This can't be undone.`)) return;
          deleteFarm(meta.id);
          if (isActive) {
            // The module-level save in main.ts was loaded for THIS farm —
            // reload (no autoboot flag) to land back on a clean menu.
            location.reload();
            return;
          }
          renderFarms();
        });
        row.appendChild(delBtn);
        rows.appendChild(row);
      }
      // Fill in human county names once (if) the index arrives.
      void indexPromise.then((index) => {
        if (!index) return;
        rows.querySelectorAll<HTMLElement>("[data-county]").forEach((el) => {
          const entry = index.find((c) => c.id === el.dataset.county);
          if (entry) el.textContent = `${entry.name}, ${entry.state}`;
        });
      });
    }
    renderFarms();

    // ---- new-farm picker -------------------------------------------------
    const newSection = $("hs-new");
    const stateSel = $("hs-state") as HTMLSelectElement;
    const countyInput = $("hs-county") as HTMLInputElement;
    const countyList = $("hs-county-list");
    const createBtn = $("hs-create") as HTMLButtonElement;
    let picked: CountyIndexEntry | null = null;
    let building = false;

    $("hs-new-toggle").addEventListener("click", () => {
      const open = newSection.style.display === "block";
      newSection.style.display = open ? "none" : "block";
      if (!open) void populateStates();
    });
    if (sessionStorage.getItem(MENU_OPEN_NEW_KEY)) {
      sessionStorage.removeItem(MENU_OPEN_NEW_KEY);
      newSection.style.display = "block";
      void populateStates();
    }

    let statesReady = false;
    async function populateStates(): Promise<void> {
      if (statesReady) return;
      const index = await indexPromise;
      if (!index) {
        showError("Couldn't load the county list — check your connection and reload.");
        return;
      }
      statesReady = true;
      const states = [...new Set(index.map((c) => c.state))].sort();
      stateSel.innerHTML =
        `<option value="">Choose a state…</option>` +
        states.map((s) => `<option value="${s}">${s}</option>`).join("");
    }

    async function refreshCountyList(): Promise<void> {
      const index = await indexPromise;
      if (!index) return;
      const state = stateSel.value;
      const q = countyInput.value.trim().toLowerCase();
      countyList.innerHTML = "";
      if (!state) return;
      const matches = index
        .filter((c) => c.state === state && (!q || c.name.toLowerCase().includes(q)))
        .slice(0, 12);
      for (const entry of matches) {
        const opt = document.createElement("div");
        opt.className = "hs-county-opt";
        opt.innerHTML =
          escapeHtml(entry.name) +
          (isBundled(entry.id) ? `<span class="hs-badge">instant</span>` : "");
        opt.addEventListener("click", () => pickCounty(entry));
        countyList.appendChild(opt);
      }
    }
    stateSel.addEventListener("change", () => void refreshCountyList());
    countyInput.addEventListener("input", () => void refreshCountyList());

    function pickCounty(entry: CountyIndexEntry): void {
      picked = entry;
      countyList.innerHTML = "";
      countyInput.value = entry.name;
      const pickedBox = $("hs-picked");
      pickedBox.style.display = "flex";
      $("hs-picked-name").textContent = `${entry.name}, ${entry.state}`;
      $("hs-picked-sub").textContent = isBundled(entry.id)
        ? "Bundled — starts instantly."
        : "First load downloads road data (~10–30 s), then it's instant.";
      const img = $("hs-thumb") as HTMLImageElement;
      img.style.display = "";
      img.onerror = () => (img.style.display = "none");
      img.src = thumbUrl(entry.bbox);
      createBtn.disabled = false;
      hideError();
    }

    createBtn.addEventListener("click", () => void doCreate());
    async function doCreate(): Promise<void> {
      if (!picked || building) return;
      building = true;
      createBtn.disabled = true;
      hideError();
      const progress = $("hs-progress");
      const label = $("hs-progress-label");
      progress.style.display = "block";
      const stageText: Record<BuildStage, string> = {
        query: "Contacting the road-data server…",
        download: "Downloading roads…",
        parse: "Processing road data…",
        "cache-write": "Saving for next time…",
      };
      try {
        // BUILD FIRST — only create the farm once its county actually loads.
        await loadCounty(picked.id, (stage, d) => {
          const mb = d?.bytes ? ` ${(d.bytes / 1e6).toFixed(1)} MB` : "";
          label.textContent = stageText[stage] + mb;
        });
        const meta = createFarm(countyNameDefault(), picked.id);
        sessionStorage.setItem(AUTOBOOT_KEY, meta.id);
        location.reload();
      } catch (err) {
        progress.style.display = "none";
        building = false;
        createBtn.disabled = false;
        showError(err instanceof CountyBuildError ? err.message : String((err as Error)?.message ?? err));
      }
    }

    function countyNameDefault(): string {
      const typed = ($("hs-name") as HTMLInputElement).value.trim();
      if (typed) return typed;
      // "Story County Farm" reads better than the generic "Farm N" fallback.
      return picked ? `${picked.name.replace(/ (County|Parish|city)$/i, "")} Farm` : "";
    }

    function showError(msg: string): void {
      const el = $("hs-error");
      el.textContent = msg;
      el.style.display = "block";
    }
    function hideError(): void {
      $("hs-error").style.display = "none";
    }

    // Safety net: if the farm list is somehow empty (all deleted elsewhere),
    // ensure one exists so the menu always has something to show.
    if (listFarms().length === 0) {
      ensureActiveFarm();
      renderFarms();
    }
  });
}
