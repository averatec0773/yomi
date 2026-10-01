/** The parts of a KeyboardEvent the shortcut matcher reads (so tests can pass plain objects). */
export interface KeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** Physical keys → [plain, with Shift] on a US layout, for events whose `key` is not a plain ASCII character. */
const CODE_KEYS: Record<string, readonly [string, string]> = {
  Backslash: ["\\", "|"],
  // JIS keyboards: the ¥ key sits where US has backslash and types "¥" by default.
  IntlYen: ["\\", "|"],
  IntlRo: ["\\", "_"],
  Slash: ["/", "?"],
  Comma: [",", "<"],
  Period: [".", ">"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  Backquote: ["`", "~"],
  Digit0: ["0", ")"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
};

const printable = (k: string) => /^[\x21-\x7e]$/.test(k);

/**
 * The shortcut key name of a keydown, or null when it cannot be a shortcut: modifiers alone, ⌘/Ctrl combinations,
 * Tab, Enter, Space, Esc, arrows and other named keys. Letters are lower case (Shift+X is "x"; callers read
 * `shiftKey` themselves), other characters are what the layout typed ("?" for Shift+/). AltGr / Option combinations
 * that type a plain ASCII character count as that character (a German "\" is AltGr+ß). When `key` is not ASCII
 * (an IME in Chinese punctuation mode reports "、" or "Process" for backslash, a JIS ¥ key reports "¥"), the
 * physical key decides, read as a US layout.
 */
export function keyFromEvent(e: KeyLike): string | null {
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey) return null;
  const key = e.key;
  if (key.length === 1 && printable(key)) return /[A-Z]/.test(key) ? key.toLowerCase() : key;
  if (e.altKey) return null;
  const typedSomething = [...key].length === 1 && key !== " ";
  if (!typedSomething && key !== "Process" && key !== "Unidentified" && key !== "Dead") return null;
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const pair = CODE_KEYS[code];
  return pair ? pair[e.shiftKey ? 1 : 0] : null;
}

/** True when the key event should not trigger shortcuts: typing in a field or an editable element. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
