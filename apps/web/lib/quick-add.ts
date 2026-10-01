/** Opens the global quick-add palette from anywhere on the client. Optional text prefills the input. */
export const QUICK_ADD_EVENT = "yomi:quick-add";

export function openQuickAdd(text?: string): void {
  window.dispatchEvent(new CustomEvent<{ text?: string }>(QUICK_ADD_EVENT, { detail: { text } }));
}
