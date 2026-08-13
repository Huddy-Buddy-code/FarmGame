/**
 * In-game modal dialogs (2026-07-30) — replaces `window.confirm` / `prompt`.
 *
 * Fourteen native dialogs used to interrupt a game with a deliberately cozy
 * cream-and-wood look with an OS-chrome box, and — worse — `confirm()` BLOCKS
 * the JS thread, so the sim loop froze for as long as the box was open. These
 * are plain DOM in the game's own `.panel` vocabulary and resolve a Promise
 * instead of returning, so the world keeps breathing behind them.
 *
 * Because they DON'T block, a dialog's premise can go stale while it's open
 * (money spent by an auto-sell, a field sold from another panel). Every caller
 * still funnels through the same validating buy/sell function it always did —
 * the dialog asks, it never authorizes.
 *
 * One dialog at a time: opening a second while one is up rejects nothing, it
 * just resolves the first as cancelled. Keyboard: Enter accepts, Escape
 * cancels, and focus is moved into the dialog and restored on close.
 */

export interface ConfirmOptions {
  title: string;
  /** Optional supporting line under the title. */
  body?: string;
  /** Accept-button label. Default "OK". */
  okLabel?: string;
  cancelLabel?: string;
  /** Style the accept button as destructive (selling, deleting). */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  body?: string;
  /** Pre-filled value; the input opens with it selected. */
  value?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** Resolve null instead of "" when the player clears the box. */
  placeholder?: string;
}

/** Resolver for the dialog currently on screen, if any. */
let closeCurrent: ((value: never) => void) | null = null;

interface DialogSpec {
  title: string;
  body?: string;
  okLabel: string;
  cancelLabel: string;
  danger: boolean;
  input?: { value: string; placeholder?: string };
}

/**
 * Build, show, and await one dialog. Resolves `null` on cancel; on accept,
 * resolves the input's value for a prompt or `true` for a confirm.
 */
function openDialog(spec: DialogSpec): Promise<string | true | null> {
  // Only one at a time — an older dialog resolves as cancelled.
  closeCurrent?.(undefined as never);

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "modal panel";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = spec.title;
    dialog.appendChild(title);
    // The dialog is announced by its title; no separate aria-label to drift.
    title.id = "modal-title";
    dialog.setAttribute("aria-labelledby", title.id);

    if (spec.body) {
      const body = document.createElement("div");
      body.className = "modal-body";
      body.textContent = spec.body;
      dialog.appendChild(body);
    }

    let input: HTMLInputElement | undefined;
    if (spec.input) {
      input = document.createElement("input");
      input.className = "modal-input";
      input.type = "text";
      input.value = spec.input.value;
      if (spec.input.placeholder) input.placeholder = spec.input.placeholder;
      dialog.appendChild(input);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-cancel";
    cancelBtn.textContent = spec.cancelLabel;
    const okBtn = document.createElement("button");
    okBtn.className = "modal-ok " + (spec.danger ? "danger" : "primary");
    okBtn.textContent = spec.okLabel;
    actions.append(cancelBtn, okBtn);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);

    const finish = (value: string | true | null): void => {
      if (closeCurrent !== settle) return; // already closed
      closeCurrent = null;
      document.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      previouslyFocused?.focus?.();
      resolve(value);
    };
    // Registered so a second dialog can cancel this one (see the top of the fn).
    const settle = (): void => finish(null);
    closeCurrent = settle as (value: never) => void;

    const accept = (): void => finish(input ? input.value : true);

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter") {
        // Enter on the Cancel button should cancel, not accept.
        if (document.activeElement === cancelBtn) return;
        e.preventDefault();
        e.stopPropagation();
        accept();
      } else if (e.key === "Tab") {
        // Minimal focus trap: keep Tab inside the two buttons + input.
        const focusable = [input, cancelBtn, okBtn].filter(Boolean) as HTMLElement[];
        const i = focusable.indexOf(document.activeElement as HTMLElement);
        if (i === -1) return;
        e.preventDefault();
        const next = e.shiftKey ? (i - 1 + focusable.length) % focusable.length : (i + 1) % focusable.length;
        focusable[next]!.focus();
      }
    }
    // Capture phase so the dialog sees Escape before any map/panel handler.
    document.addEventListener("keydown", onKey, true);

    cancelBtn.addEventListener("click", () => finish(null));
    okBtn.addEventListener("click", accept);
    // Clicking the dimmed area cancels; clicking the dialog itself must not.
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) finish(null);
    });

    if (input) {
      input.focus();
      input.select();
    } else {
      okBtn.focus();
    }
  });
}

/** Ask a yes/no question. Resolves true only if the player accepted. */
export async function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const res = await openDialog({
    title: opts.title,
    body: opts.body,
    okLabel: opts.okLabel ?? "OK",
    cancelLabel: opts.cancelLabel ?? "Cancel",
    danger: opts.danger ?? false,
  });
  return res === true;
}

/**
 * Ask for a line of text. Resolves the entered string, or null if cancelled —
 * same contract as `window.prompt`, so call sites keep their null checks.
 */
export async function promptDialog(opts: PromptOptions): Promise<string | null> {
  const res = await openDialog({
    title: opts.title,
    body: opts.body,
    okLabel: opts.okLabel ?? "Save",
    cancelLabel: opts.cancelLabel ?? "Cancel",
    danger: false,
    input: { value: opts.value ?? "", placeholder: opts.placeholder },
  });
  return typeof res === "string" ? res : null;
}

/** True while a dialog is on screen — lets global key handlers stand down. */
export function modalIsOpen(): boolean {
  return closeCurrent !== null;
}
