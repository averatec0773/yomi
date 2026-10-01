import type { StatementPayment } from "@yomi/contracts";
import { linkText, paymentTitle } from "@yomi/core/payment";
import { formatPhone, phoneHref } from "@yomi/core/phone";
import { AtSignIcon, LandmarkIcon, LinkIcon, type LucideIcon, MailIcon, PhoneIcon, SmartphoneIcon, UserRoundIcon, WalletIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { type Dictionary, fmt } from "@/i18n";
import { cn } from "@/lib/utils";
import { QrCode } from "./qr-code";

/** Neutral lucide icons (no brand logos): a bank for Zelle, a phone for app wallets, a wallet for anything else. */
export function paymentKindIcon(kind: StatementPayment["kind"]): LucideIcon {
  if (kind === "zelle") return LandmarkIcon;
  return kind === "other" ? WalletIcon : SmartphoneIcon;
}

/** "Zelle (Chase)", "Venmo", "Zelle · Joint account" in the dictionary's language. */
export function methodTitle(t: Dictionary, m: Pick<StatementPayment, "kind" | "label">): string {
  return paymentTitle(m.kind, t.settings.payment.kinds[m.kind], m.label);
}

/** A link as text that may wrap after each "/" (never inside a word, unless one part alone is too wide). */
function breakable(text: string) {
  return text.split("/").map((part, i) => (
    <Fragment key={i}>
      {i > 0 && (
        <>
          /<wbr />
        </>
      )}
      {part}
    </Fragment>
  ));
}

/** One contact value on its own line: a 13px icon, then the value (13px, text-2), labelled for screen readers. */
function ContactLine({ icon: Icon, label, testId, children }: { icon: LucideIcon; label: string; testId: string; children: ReactNode }) {
  return (
    <p className="mt-0.5 flex items-start gap-1.5 text-meta break-words text-2" data-testid={testId}>
      <Icon className="mt-[3px] size-[13px] shrink-0 text-3" aria-label={label} role="img" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

const linkClass = "text-primary underline-offset-2 hover:underline";

function Method({ m, t, currency, variant }: { m: StatementPayment; t: Dictionary; currency: string; variant: "sheet" | "paper" }) {
  const p = t.split.print;
  const tel = m.phone ? phoneHref(m.phone) : null;
  const Icon = paymentKindIcon(m.kind);
  const title = methodTitle(t, m);
  const textIsLink = m.text !== null && m.link !== null && m.link === m.text.trim();
  const caption = m.kind === "other" ? p.payScanLink : fmt(p.payScan, { app: t.settings.payment.kinds[m.kind] });
  return (
    <li className={cn("print-pay-item flex min-w-0 flex-wrap items-start gap-4", variant === "sheet" ? "border-b border-line-soft px-3 py-2.5 last:border-b-0" : "py-3")}>
      <div className="min-w-0 flex-1 basis-36">
        <p className="flex items-center gap-1.5 text-body font-medium">
          <Icon className="size-3.5 shrink-0 text-2" aria-hidden />
          <span className="min-w-0 break-words">{title}</span>
        </p>
        {m.email && (
          <ContactLine icon={MailIcon} label={p.payEmail} testId="pay-email">
            <a href={`mailto:${m.email}`} className={linkClass}>
              {m.email}
            </a>
          </ContactLine>
        )}
        {m.phone && (
          <ContactLine icon={PhoneIcon} label={p.payPhone} testId="pay-phone">
            {tel ? (
              <a href={tel} className={cn(linkClass, "whitespace-nowrap")}>
                {formatPhone(m.phone, { currency })}
              </a>
            ) : (
              <span className="whitespace-nowrap">{formatPhone(m.phone, { currency })}</span>
            )}
          </ContactLine>
        )}
        {m.username && (
          <ContactLine icon={AtSignIcon} label={p.payUsername} testId="pay-username">
            {m.username}
          </ContactLine>
        )}
        {m.text && !textIsLink && (
          <ContactLine icon={UserRoundIcon} label={p.payAccount} testId="pay-text">
            {m.text}
          </ContactLine>
        )}
        {m.link && (
          <ContactLine icon={LinkIcon} label={p.payLink} testId="pay-link">
            <a href={m.link} target="_blank" rel="noreferrer" className={linkClass}>
              {breakable(linkText(m.link))}
            </a>
          </ContactLine>
        )}
      </div>
      {m.qr && (
        <figure className="flex shrink-0 flex-col items-center gap-1">
          {m.original ? (
            // The user's own QR card as imported (name and logo included), untouched in every theme: 160px on screen, 36mm on paper.
            <img
              src={m.original.dataUrl}
              width={m.original.width}
              height={m.original.height}
              alt={fmt(t.settings.payment.qrImage, { name: title })}
              data-testid="pay-qr"
              data-qr={m.qr}
              data-original=""
              className="block h-auto w-40 max-w-none rounded-xl border border-border print:w-[36mm]"
            />
          ) : (
            <QrCode value={m.qr} label={fmt(t.settings.payment.qrImage, { name: title })} className="size-24 print:size-[28mm]" testId="pay-qr" />
          )}
          <figcaption className="text-center text-hint whitespace-nowrap text-3">{caption}</figcaption>
        </figure>
      )}
    </li>
  );
}

/**
 * "My payment details" on a statement: the user's payment methods for its currency (core `Statement.payment`), each
 * with its email (mailto), phone (a tel: link in E.164, shown by `formatPhone` for the statement's `currency`: US
 * "202-555-0143", with "+1 " when the currency is not USD), username or account on their own lines with an icon, a
 * link when there is one, and the QR code drawn from its payload. `sheet`: the compact list at the end of
 * the statement dialog. `paper`: one bordered block after the sections of the print view, two columns from `sm`,
 * never split across pages. Nothing when the list is empty. Server and client (no hooks).
 */
export function HowToPay({
  methods,
  t,
  currency,
  variant,
}: {
  methods: StatementPayment[];
  t: Dictionary;
  currency: string;
  variant: "sheet" | "paper";
}) {
  if (methods.length === 0) return null;
  const p = t.split.print;
  if (variant === "sheet") {
    return (
      <section aria-label={p.payTitle} data-testid="statement-pay">
        <h3 className="flex h-9 items-center border-b border-line-soft bg-raised px-3 text-meta font-medium text-2">{p.payTitle}</h3>
        <ul>
          {methods.map((m, i) => (
            <Method key={i} m={m} t={t} currency={currency} variant="sheet" />
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section className="print-pay mt-6 rounded-xl border border-border bg-surface" data-testid="print-pay" aria-labelledby="print-pay-title">
      <h2 id="print-pay-title" className="flex min-h-12 items-center border-b border-line-soft px-4 py-2.5 text-title font-semibold md:px-5 print:px-5">
        {p.payTitle}
      </h2>
      <ul className="grid gap-x-8 px-4 py-1 sm:grid-cols-2 md:px-5 print:px-5">
        {methods.map((m, i) => (
          <Method key={i} m={m} t={t} currency={currency} variant="paper" />
        ))}
      </ul>
    </section>
  );
}
