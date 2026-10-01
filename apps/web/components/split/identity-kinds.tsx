import type { IdentityKind } from "@yomi/contracts";
import { AtSignIcon, LandmarkIcon, MessageCircleIcon, PhoneIcon, SmartphoneIcon, UserIcon, WalletIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

/** Labels and input hints live in the `split.kinds` / `split.kindPlaceholders` dictionary entries. */
export const KIND_ORDER: IdentityKind[] = ["wechat", "alipay", "zelle_name", "zelle_email", "zelle_phone", "venmo", "bank_name", "other"];

const ICON: Record<IdentityKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  wechat: MessageCircleIcon,
  alipay: WalletIcon,
  zelle_name: LandmarkIcon,
  zelle_email: AtSignIcon,
  zelle_phone: PhoneIcon,
  venmo: SmartphoneIcon,
  bank_name: LandmarkIcon,
  other: UserIcon,
};

export function KindIcon({ kind, className }: { kind: IdentityKind; className?: string }) {
  const Icon = ICON[kind];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0 text-2", className)} />;
}
