import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  AwardIcon,
  BadgePercentIcon,
  BookOpenIcon,
  BriefcaseIcon,
  BusIcon,
  CarIcon,
  CircleDashedIcon,
  ClapperboardIcon,
  CoffeeIcon,
  CoinsIcon,
  CreditCardIcon,
  FuelIcon,
  GiftIcon,
  GraduationCapIcon,
  HandHeartIcon,
  HeartHandshakeIcon,
  HeartPulseIcon,
  HouseIcon,
  LandmarkIcon,
  LaptopIcon,
  type LucideIcon,
  MessageSquareIcon,
  PackageIcon,
  PenLineIcon,
  PercentIcon,
  PlaneIcon,
  ReceiptIcon,
  RepeatIcon,
  ShapesIcon,
  ShirtIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
  SmartphoneIcon,
  TagIcon,
  Undo2Icon,
  UtensilsIcon,
  WalletIcon,
  ZapIcon,
} from "lucide-react";
import type { TransactionItem } from "@yomi/contracts";
import { IconTile } from "@/components/ui-kit/icon-tile";

/** Seeded system categories (stored in Chinese) → icon. Categories are told apart by shape, never by hue. */
const SYSTEM: Record<string, LucideIcon> = {
  餐饮: UtensilsIcon,
  买菜: ShoppingCartIcon,
  交通: CarIcon,
  购物: ShoppingBagIcon,
  日用: PackageIcon,
  居住: HouseIcon,
  娱乐: ClapperboardIcon,
  订阅: RepeatIcon,
  医疗: HeartPulseIcon,
  教育: GraduationCapIcon,
  旅行: PlaneIcon,
  人情: GiftIcon,
  公益: HandHeartIcon,
  其他: ShapesIcon,
  工资: BriefcaseIcon,
  奖金: AwardIcon,
  利息: PercentIcon,
  返现: BadgePercentIcon,
  家人资助: HeartHandshakeIcon,
  报销: ReceiptIcon,
  副业收入: LaptopIcon,
  退款: Undo2Icon,
  转入: ArrowDownLeftIcon,
  其他收入: CoinsIcon,
};

/** User-created categories: a few keywords (English or Chinese) pick an icon from the same small set. */
const KEYWORDS: [RegExp, LucideIcon][] = [
  [/coffee|cafe|tea|boba|咖啡|奶茶|茶/i, CoffeeIcon],
  [/food|dining|restaurant|lunch|dinner|meal|餐|饭|吃/i, UtensilsIcon],
  [/grocer|market|supermarket|菜|超市/i, ShoppingCartIcon],
  [/gas|fuel|油/i, FuelIcon],
  [/bus|metro|subway|train|transit|地铁|公交/i, BusIcon],
  [/car|taxi|uber|lyft|parking|车|停车/i, CarIcon],
  [/rent|home|house|housing|房|住/i, HouseIcon],
  [/util|electric|power|water|bill|电|水费|燃气/i, ZapIcon],
  [/phone|mobile|internet|话费|手机|网/i, SmartphoneIcon],
  [/cloth|shoe|apparel|衣|鞋/i, ShirtIcon],
  [/shop|amazon|购/i, ShoppingBagIcon],
  [/sub|stream|netflix|spotify|订阅|会员/i, RepeatIcon],
  [/health|medical|doctor|pharm|医|药/i, HeartPulseIcon],
  [/book|course|school|tuition|学|书/i, BookOpenIcon],
  [/travel|flight|hotel|trip|旅|机票|酒店/i, PlaneIcon],
  [/gift|礼|红包/i, GiftIcon],
  [/salary|pay|wage|工资|薪/i, BriefcaseIcon],
];

/** Icon for a stored category name (null → uncategorized), with transfers shown by kind. */
export function categoryIcon(name: string | null, kind?: TransactionItem["kind"]): LucideIcon {
  if (kind === "transfer") return ArrowLeftRightIcon;
  if (!name) return CircleDashedIcon;
  const system = SYSTEM[name];
  if (system) return system;
  return KEYWORDS.find(([re]) => re.test(name))?.[1] ?? TagIcon;
}

/** Neutral category tile (IconTile): grey line icon on a neutral square. 36px in desktop rows, 42px on phones (`size="lg"`). */
export function CategoryTile({
  name,
  kind,
  size = "md",
  className,
}: {
  name: string | null;
  kind?: TransactionItem["kind"];
  size?: "md" | "lg" | "responsive";
  className?: string;
}) {
  return <IconTile icon={categoryIcon(name, kind)} size={size} className={className} />;
}

/** Where a row came from: wallet (Alipay, WeChat), card, bank, SMS alert, or typed by hand. */
export function sourceIcon(tx: Pick<TransactionItem, "source" | "accountName">): LucideIcon {
  switch (tx.source) {
    case "alipay":
    case "wechat":
      return WalletIcon;
    case "icbc_pdf":
      return CreditCardIcon;
    case "sms":
      return MessageSquareIcon;
    case "manual":
      return tx.accountName && /信用卡|credit/i.test(tx.accountName) ? CreditCardIcon : PenLineIcon;
    default:
      return tx.accountName && /信用卡|credit|card/i.test(tx.accountName) ? CreditCardIcon : LandmarkIcon;
  }
}
