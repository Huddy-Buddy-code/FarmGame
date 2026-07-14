import { describe, it, expect, beforeEach } from "vitest";

/**
 * This Vitest project runs in a plain Node environment (no jsdom), so
 * `localStorage` isn't a global — persistence.ts calls it dynamically inside
 * each function body (never captured at import time), so a minimal in-memory
 * polyfill installed before each test is enough to exercise the real module.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

beforeEach(() => {
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage();
});

// Imported AFTER the localStorage polyfill is registerable per-test via
// beforeEach above — the module itself only touches `localStorage` inside
// function bodies, so import order relative to the polyfill doesn't matter.
import {
  ensureActiveFarm, listFarms, getActiveFarmId, getFarmMeta, createFarm, renameFarm,
  switchFarm, deleteFarm, persistGame, loadGame, loadGameFor, clearSavedGame,
} from "../src/state/persistence";
import { newGame } from "../src/state/saveState";

function freshSave() {
  const save = newGame();
  save.money = 12345;
  return save;
}

describe("multi-farm persistence (maintainer request, 2026-07-13)", () => {
  it("a fresh install has no farms until ensureActiveFarm creates one", () => {
    expect(listFarms()).toEqual([]);
    expect(getActiveFarmId()).toBeNull();
    const meta = ensureActiveFarm();
    expect(meta.name).toBe("Farm 1");
    expect(getActiveFarmId()).toBe(meta.id);
    expect(listFarms()).toHaveLength(1);
    // Idempotent — doesn't create a second farm.
    const again = ensureActiveFarm();
    expect(again.id).toBe(meta.id);
    expect(listFarms()).toHaveLength(1);
  });

  it("persistGame/loadGame round-trip against whichever farm is active", () => {
    ensureActiveFarm();
    expect(loadGame()).toBeNull(); // never saved yet
    const save = freshSave();
    persistGame({ save, clockNow: 4200, daysPerMonth: 20 });
    const loaded = loadGame()!;
    expect(loaded.clockNow).toBe(4200);
    expect(loaded.daysPerMonth).toBe(20);
    expect(loaded.save.money).toBe(12345);
  });

  it("createFarm adds a new farm, switches active to it, and old data stays put", () => {
    const first = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 100 });

    const second = createFarm("Big Sky Acres");
    expect(getActiveFarmId()).toBe(second.id);
    expect(listFarms().map((f) => f.name).sort()).toEqual(["Big Sky Acres", "Farm 1"]);
    expect(loadGame()).toBeNull(); // the NEW active farm has no save yet

    // The first farm's save is untouched, readable via loadGameFor.
    const firstSave = loadGameFor(first.id)!;
    expect(firstSave.clockNow).toBe(100);
  });

  it("an empty/whitespace name falls back to a default rather than an empty farm name", () => {
    ensureActiveFarm();
    const f = createFarm("   ");
    expect(f.name.trim().length).toBeGreaterThan(0);
  });

  it("renameFarm updates metadata only, not the save", () => {
    const meta = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 5 });
    renameFarm(meta.id, "Sunnyvale Farm");
    expect(getFarmMeta(meta.id)!.name).toBe("Sunnyvale Farm");
    expect(loadGame()!.clockNow).toBe(5);
  });

  it("switchFarm changes which farm loadGame/persistGame operate on", () => {
    const a = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 1 });
    const b = createFarm("Second");
    persistGame({ save: freshSave(), clockNow: 2 });

    switchFarm(a.id);
    expect(getActiveFarmId()).toBe(a.id);
    expect(loadGame()!.clockNow).toBe(1);

    switchFarm(b.id);
    expect(loadGame()!.clockNow).toBe(2);
  });

  it("switchFarm to a nonexistent id throws", () => {
    ensureActiveFarm();
    expect(() => switchFarm("nope")).toThrow();
  });

  it("deleteFarm removes its save data and metadata", () => {
    const a = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 1 });
    const b = createFarm("Second");
    persistGame({ save: freshSave(), clockNow: 2 });

    deleteFarm(b.id);
    expect(listFarms().map((f) => f.id)).toEqual([a.id]);
    expect(loadGameFor(b.id)).toBeNull();
  });

  it("deleting the ACTIVE farm switches to another existing farm", () => {
    const a = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 1 });
    const b = createFarm("Second"); // now active
    persistGame({ save: freshSave(), clockNow: 2 });

    const newActive = deleteFarm(b.id);
    expect(newActive).toBe(a.id);
    expect(getActiveFarmId()).toBe(a.id);
  });

  it("deleting the LAST farm auto-creates a fresh one so there's always an active farm", () => {
    const only = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 1 });

    const newActive = deleteFarm(only.id);
    expect(newActive).not.toBe(only.id);
    expect(listFarms()).toHaveLength(1);
    expect(loadGame()).toBeNull(); // brand new farm, no save yet
  });

  it("clearSavedGame (the Reset button) wipes only the active farm's save, keeps its name/id", () => {
    const meta = ensureActiveFarm();
    persistGame({ save: freshSave(), clockNow: 99 });
    clearSavedGame();
    expect(loadGame()).toBeNull();
    expect(getFarmMeta(meta.id)!.name).toBe("Farm 1"); // farm itself still exists
    expect(listFarms()).toHaveLength(1);
  });

  it("a legacy single-slot save (pre-farms) migrates into 'Farm 1' on first read", () => {
    // Simulate the OLD save shape sitting under the old key, with no index yet.
    const legacy = { save: freshSave(), clockNow: 777, daysPerMonth: 30 };
    localStorage.setItem("farm-sim-save-v1", JSON.stringify(legacy));

    const meta = ensureActiveFarm();
    expect(meta.name).toBe("Farm 1");
    expect(listFarms()).toHaveLength(1);
    expect(loadGame()!.clockNow).toBe(777);
    // The legacy key is cleaned up after migration.
    expect(localStorage.getItem("farm-sim-save-v1")).toBeNull();
  });
});
