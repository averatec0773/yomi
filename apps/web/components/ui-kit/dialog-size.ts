export type DialogSize = "sm" | "md" | "lg";

/**
 * The dialog width scale: `sm` 480 (confirmations, read-only details), `md` 640 (forms: settle, record, transfer,
 * opening balance), `lg` 760 (the statement). Never wider than the viewport minus 32px. `lg` becomes a full-height
 * sheet on phones.
 */
export const DIALOG_SIZE: Record<DialogSize, string> = {
  sm: "sm:max-w-[min(480px,calc(100vw-2rem))]",
  md: "sm:max-w-[min(640px,calc(100vw-2rem))]",
  lg: "max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:ring-0 sm:h-[min(880px,calc(100dvh-4rem))] sm:max-w-[min(760px,calc(100vw-2rem))]",
};

export function dialogSize(size: DialogSize): string {
  return DIALOG_SIZE[size];
}
