export type HarnessShortcut = "command-palette" | "new-task";

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest("input, textarea, select, [contenteditable], [role='textbox']");
  if (!editable) return false;

  if (editable instanceof HTMLInputElement) {
    return !editable.disabled && !editable.readOnly && !NON_TEXT_INPUT_TYPES.has(editable.type);
  }
  if (editable instanceof HTMLTextAreaElement) {
    return !editable.disabled && !editable.readOnly;
  }
  if (editable instanceof HTMLSelectElement) return !editable.disabled;
  if (editable.getAttribute("role") === "textbox") {
    return editable.getAttribute("aria-readonly") !== "true";
  }

  const contentEditable = editable.getAttribute("contenteditable");
  return contentEditable === ""
    || contentEditable === "true"
    || contentEditable === "plaintext-only"
    || (editable instanceof HTMLElement && editable.isContentEditable);
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): HarnessShortcut | null {
  if (
    event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.shiftKey
    || !(event.metaKey || event.ctrlKey)
    || isEditableTarget(event.target)
  ) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key === "k") return "command-palette";
  if (key === "n") return "new-task";
  return null;
}
