import { describe, expect, it } from "vitest";
import { shortcutFromKeyboardEvent } from "./keyboard-shortcuts";

function keyboardEvent(
  init: KeyboardEventInit,
  target: EventTarget = window,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { configurable: true, value: target });
  return event;
}

describe("global keyboard shortcuts", () => {
  it("maps exact command and control shortcuts", () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: "k", metaKey: true })))
      .toBe("command-palette");
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: "N", ctrlKey: true })))
      .toBe("new-task");
  });

  it("ignores editable targets, composition, repeats, and prevented events", () => {
    const textarea = document.createElement("textarea");
    const contentEditable = document.createElement("div");
    contentEditable.setAttribute("contenteditable", "true");

    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: "n", metaKey: true }, textarea)))
      .toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: "k", metaKey: true }, contentEditable)))
      .toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: "k", metaKey: true, isComposing: true })))
      .toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent({ key: "k", metaKey: true, repeat: true })))
      .toBeNull();

    const prevented = keyboardEvent({ key: "k", metaKey: true });
    prevented.preventDefault();
    expect(shortcutFromKeyboardEvent(prevented)).toBeNull();
  });
});
