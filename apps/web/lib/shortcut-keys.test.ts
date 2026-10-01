import { describe, expect, it } from "vitest";
import { keyFromEvent } from "./shortcut-keys";

describe("keyFromEvent", () => {
  it("reads plain characters, backslash included", () => {
    expect(keyFromEvent({ key: "\\", code: "Backslash" })).toBe("\\");
    expect(keyFromEvent({ key: "t", code: "KeyT" })).toBe("t");
    expect(keyFromEvent({ key: ";", code: "Semicolon" })).toBe(";");
    expect(keyFromEvent({ key: ",", code: "Comma" })).toBe(",");
  });

  it("lower-cases Shift+letter and keeps the typed symbol for Shift+punctuation", () => {
    expect(keyFromEvent({ key: "X", code: "KeyX", shiftKey: true })).toBe("x");
    expect(keyFromEvent({ key: "?", code: "Slash", shiftKey: true })).toBe("?");
    expect(keyFromEvent({ key: "|", code: "Backslash", shiftKey: true })).toBe("|");
  });

  it("refuses modifiers alone, ⌘/Ctrl combinations and named keys", () => {
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Enter", " ", "Escape", "ArrowDown", "Backspace", "F5"]) {
      expect(keyFromEvent({ key, code: "" })).toBeNull();
    }
    expect(keyFromEvent({ key: "k", code: "KeyK", metaKey: true })).toBeNull();
    expect(keyFromEvent({ key: "k", code: "KeyK", ctrlKey: true })).toBeNull();
  });

  it("falls back to the physical key when the layout or an IME reports something else", () => {
    // Chinese IME in full-width punctuation mode, and IME composition.
    expect(keyFromEvent({ key: "、", code: "Backslash" })).toBe("\\");
    expect(keyFromEvent({ key: "Process", code: "Backslash" })).toBe("\\");
    expect(keyFromEvent({ key: "Process", code: "KeyT" })).toBe("t");
    expect(keyFromEvent({ key: "；", code: "Semicolon" })).toBe(";");
    expect(keyFromEvent({ key: "？", code: "Slash", shiftKey: true })).toBe("?");
    // JIS ¥ key.
    expect(keyFromEvent({ key: "¥", code: "IntlYen" })).toBe("\\");
    // A dead key on an international layout.
    expect(keyFromEvent({ key: "Dead", code: "Quote" })).toBe("'");
    // Cyrillic letters map to the Latin key in the same place.
    expect(keyFromEvent({ key: "е", code: "KeyT" })).toBe("t");
  });

  it("takes AltGr / Option characters only when they are plain ASCII", () => {
    // German Windows: AltGr (Ctrl+Alt) + ß types a backslash; macOS German: Option+Shift+7.
    expect(keyFromEvent({ key: "\\", code: "Minus", ctrlKey: true, altKey: true })).toBe("\\");
    expect(keyFromEvent({ key: "\\", code: "Digit7", altKey: true, shiftKey: true })).toBe("\\");
    // US macOS Option+t types "†": not a shortcut.
    expect(keyFromEvent({ key: "†", code: "KeyT", altKey: true })).toBeNull();
  });
});
