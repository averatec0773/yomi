import {
  ChartColumnIcon,
  FileInputIcon,
  KeyboardIcon,
  ListChecksIcon,
  type LucideIcon,
  ReceiptTextIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WalletIcon,
  WrenchIcon,
} from "lucide-react";

/** One icon per nav destination, shared by the sidebar, the phone tabs and the Tools hub. */
export const NAV_ICONS: Record<string, LucideIcon> = {
  "/transactions": ReceiptTextIcon,
  "/stats": ChartColumnIcon,
  "/assets": WalletIcon,
  "/tools": WrenchIcon,
  "/settings": SlidersHorizontalIcon,
  "/split": UsersIcon,
  "/import": FileInputIcon,
  "/tools/rules": ListChecksIcon,
};

export const ShortcutsIcon = KeyboardIcon;
