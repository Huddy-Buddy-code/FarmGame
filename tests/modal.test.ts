// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { confirmDialog, promptDialog, modalIsOpen } from "../src/ui/modal";

/**
 * The modal replaced window.confirm/prompt, which means it now sits in front of
 * BUYING LAND and every sale — a dialog that fails to resolve would hang the
 * core loop with no error. Browser Preview is off in this project, so these are
 * the only eyes on it.
 */

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`no element matching ${sel}`);
  return el;
};

function key(k: string, opts: KeyboardEventInit = {}): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...opts }));
}

afterEach(() => {
  // Escape any dialog a failing test left standing.
  if (modalIsOpen()) key("Escape");
  document.body.innerHTML = "";
});

describe("confirmDialog", () => {
  it("renders the title, body and labels, and reports itself open", async () => {
    const p = confirmDialog({ title: "Sell Silo?", body: "You get $1,000.", okLabel: "Sell", danger: true });
    expect(modalIsOpen()).toBe(true);
    expect($(".modal-title").textContent).toBe("Sell Silo?");
    expect($(".modal-body").textContent).toBe("You get $1,000.");
    expect($(".modal-ok").textContent).toBe("Sell");
    expect($(".modal-ok").classList.contains("danger")).toBe(true);
    expect($(".modal-cancel").textContent).toBe("Cancel");
    $<HTMLButtonElement>(".modal-cancel").click();
    await p;
  });

  it("resolves true on accept and false on cancel", async () => {
    const yes = confirmDialog({ title: "ok?" });
    $<HTMLButtonElement>(".modal-ok").click();
    expect(await yes).toBe(true);

    const no = confirmDialog({ title: "ok?" });
    $<HTMLButtonElement>(".modal-cancel").click();
    expect(await no).toBe(false);
  });

  it("tears the dialog out of the DOM on close (no leaked backdrops)", async () => {
    const p = confirmDialog({ title: "ok?" });
    expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(1);
    $<HTMLButtonElement>(".modal-ok").click();
    await p;
    expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(0);
    expect(modalIsOpen()).toBe(false);
  });

  it("Escape cancels, Enter accepts", async () => {
    const esc = confirmDialog({ title: "ok?" });
    key("Escape");
    expect(await esc).toBe(false);

    const ent = confirmDialog({ title: "ok?" });
    key("Enter");
    expect(await ent).toBe(true);
  });

  it("Enter while the CANCEL button holds focus does not accept", async () => {
    const p = confirmDialog({ title: "ok?" });
    $<HTMLButtonElement>(".modal-cancel").focus();
    key("Enter");
    // Still open — Enter was ignored rather than treated as an accept.
    expect(modalIsOpen()).toBe(true);
    key("Escape");
    expect(await p).toBe(false);
  });

  it("clicking the dimmed backdrop cancels; clicking the dialog does not", async () => {
    const p = confirmDialog({ title: "ok?" });
    $(".modal").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(modalIsOpen()).toBe(true); // clicks inside must not dismiss
    const backdrop = $(".modal-backdrop");
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(await p).toBe(false);
  });

  it("opening a second dialog resolves the first as cancelled, leaving ONE on screen", async () => {
    const first = confirmDialog({ title: "first" });
    const second = confirmDialog({ title: "second" });
    expect(await first).toBe(false);
    expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(1);
    expect($(".modal-title").textContent).toBe("second");
    $<HTMLButtonElement>(".modal-ok").click();
    expect(await second).toBe(true);
  });

  it("omits the body element when no body is given", async () => {
    const p = confirmDialog({ title: "bare" });
    expect(document.querySelector(".modal-body")).toBeNull();
    key("Escape");
    await p;
  });

  it("is a plain (non-danger) button by default", async () => {
    const p = confirmDialog({ title: "ok?" });
    expect($(".modal-ok").classList.contains("primary")).toBe(true);
    expect($(".modal-ok").classList.contains("danger")).toBe(false);
    key("Escape");
    await p;
  });
});

describe("promptDialog", () => {
  it("pre-fills the input and resolves the edited value", async () => {
    const p = promptDialog({ title: "Name this field", value: "Field 3" });
    const input = $<HTMLInputElement>(".modal-input");
    expect(input.value).toBe("Field 3");
    input.value = "North Forty";
    $<HTMLButtonElement>(".modal-ok").click();
    expect(await p).toBe("North Forty");
  });

  it("resolves null on cancel — same contract as window.prompt, so callers' null checks hold", async () => {
    const p = promptDialog({ title: "Rename", value: "x" });
    $<HTMLButtonElement>(".modal-cancel").click();
    expect(await p).toBeNull();
  });

  it("Escape resolves null, Enter resolves the current text", async () => {
    const esc = promptDialog({ title: "Rename", value: "x" });
    key("Escape");
    expect(await esc).toBeNull();

    const ent = promptDialog({ title: "Rename", value: "x" });
    $<HTMLInputElement>(".modal-input").value = "typed";
    key("Enter");
    expect(await ent).toBe("typed");
  });

  it("distinguishes an EMPTY string from a cancel (callers fall back to a default on empty)", async () => {
    const p = promptDialog({ title: "Name", value: "Field 1" });
    $<HTMLInputElement>(".modal-input").value = "";
    $<HTMLButtonElement>(".modal-ok").click();
    const res = await p;
    expect(res).toBe("");
    expect(res).not.toBeNull();
  });
});
