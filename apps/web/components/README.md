# Web UI: components and conventions

How the pages in `apps/web` are built, for contributors. Read this before adding a page or a component; reuse what exists before writing something new.

## Visual direction

Calm and number-first: a number the user can read beats a chart they have to decode, and nothing in the UI judges spending.

- **Color carries meaning, never decoration.** Neutral greys for structure, categories and sources (categories differ by icon shape, not hue). The teal accent marks only what you can act on: the active nav item, one filled primary button per view, the Split marker, links. Green only for money coming in and gains. Clay only for "you pay X" on Split and settle and for card balances owed. Spending amounts are plain text.
- **Type scale** (px / weight): hero numbers 32 to 40 / 600 tabular; page title 24 / 600; section title 16 / 600; rows, buttons, inputs 15 / 500 or 400; meta 13 / 400; hints 12 / 400. Only weights 400, 500 and 600.
- **Icons:** lucide only, stroke set globally (never pass `strokeWidth`), 18 px in nav and tiles, 16 px in buttons. Icon-only buttons need `aria-label`. No emoji.
- **Phones:** every control has a 44 x 44 px hit area (`hit` utility); rows are at least 64 px.
- **Overlays:** popovers for quick picks (split, category, filters), dialogs for forms and confirmations (sizes from `dialogSize`: 480, 640, 760), toasts for outcomes with Undo where the action is reversible, `loading.tsx` skeletons instead of spinners.
- **Copy:** plain, specific, sentence case, in both languages. No em dashes joining clauses. The words "owe" and 欠 do not appear; balances read "To settle with Alex $719.73" or "You pay Li $40.00".
- **Balances** appear only on Split and settle (and on Transactions when filtered by that person), never in navigation.

## Tokens and theme

Design tokens and utility classes are listed in the comment block at the top of `app/globals.css`: surfaces (`bg-surface`, `bg-sunken`, ...), text colors (`text-2`, `text-3`), sizes (`text-hint` 12, `text-meta` 13, `text-body` 15, `text-title` 16, `text-page` 24, `text-hero` 36). Merge classes with `cn` from `@/lib/utils`, which knows `text-meta` is a size and `text-2` a color. Never use a hex color in a component.

The theme (Settings > Appearance: System, Light, Dark) is rendered by the root layout as `html[data-theme]` before paint; System sets no attribute and follows `prefers-color-scheme`. `useTheme()` from `@/lib/theme` reads and sets it. Both themes must work for every surface.

## Layout and pages

- The root layout renders the `Sidebar` (md and up) or `BottomTabs` (phones) from `components/shell/`, and `QuickAdd` (⌘K).
- Content is capped at `max-w-list` (1120 px); Import, Tools, Rules and Settings use `max-w-narrow` (720 px), left-aligned so every title starts at the same x.
- Every page starts with `PageHeader` and sets a tab title (`"Transactions · yomi"` through `generateMetadata`).
- **Data flow:** server components read through core (`getDb()` from `@/lib/db`, `getCurrentUser()`); client components mutate through `apiFetch('/api/...')` from `@/lib/api`, then `router.refresh()`, optimistic where speed matters. Pages that read the database have a `loading.tsx`.
- **URL is state:** periods (`?preset=`, `?from=&to=`), Settings tabs (`?tab=connections`), filters. Anchors inside Settings panels use `data-anchor` and `AnchorFlash`.

## Language (i18n)

Every user-facing string lives in `i18n/en.ts` (the source of truth; its shape is the `Dictionary` type) and `i18n/zh-CN.ts` (must satisfy the same type). Never hardcode copy.

- Server components: `const { locale, t } = await getI18n()` from `@/i18n/server`.
- Client components: `useT()` and `useLocale()` from `@/i18n/client`.
- `fmt(template, vars)` fills `{name}` placeholders, `plural(t.x.count, n)` picks `one` / `other`, `rich(template, { amount: <Money … /> })` takes React nodes.
- Errors: core and the API send a stable snake_case `code`, `params` and an English `message`; show them with `errorText(err, t)` from `@/i18n/errors`. A new code needs an entry in both dictionaries.
- Text written for someone else (the split statement, CSV exports) takes a `locale` query parameter.

## UI kit (`components/ui-kit/`)

Use these instead of the raw shadcn primitives in `components/ui/`.

| Component | Use it for |
|-----------|------------|
| `Button`, `buttonClass` | The one button: variants primary, soft, outline (default), ghost, quiet, danger; sizes `md` 40 px and `sm` 32 px |
| `PageHeader` | Title, page controls (the `PeriodBar`), actions, an optional meta line; adds the "Tools" crumb on Tools pages |
| `PeriodBar`, `periodHref` | Previous / label / next plus presets and a custom range, written to the URL; `presets="analysis"` adds the day and week presets, `notAfter` stops next at a day |
| `StatCard` | Summary numbers |
| `ListCard` | A bordered list of records with a title, icon, count and aside |
| `EmptyState` | Icon tile, one sentence, at most one action |
| `IconTile` | The neutral square behind a grey icon or an initial |
| `Segmented` | Two to four options as radio buttons, toggles or links |
| `FilterChip` | Pill with an icon for filters and menus |
| `Switch` | An on/off setting row |
| `BulkBar`, `bulkAction` | The floating bar for a multi-selection |
| `PhoneInput`, `phoneReady` | Phone numbers stored as E.164 |
| `dialogSize` | The dialog width scale (`sm`, `md`, `lg`) |
| `AnchorFlash` | Scrolls to and briefly tints a `[data-anchor]` target |

Other shared pieces: `Money` (every amount renders from integer minor units through it), `CategoryPill`, `CategoryTile` and `sourceIcon`, `CsvLink`, the skeletons in `skeleton.tsx`, and `Guide` from `components/bank/secret-form.tsx` (numbered how-to steps with external links and a "Last checked" line, used in Settings > Connections and on the Import page).

Feature folders (`transactions/`, `split/`, `stats/` (the neutral numbers on Analysis), `analysis/` (Insights, the Day view, Sources), `assets/`, `bank/`, `import/`, `payment/`, `tools/`, `shell/`) hold components used by one area; read the file header comments there.

## Helpers (`lib/`)

- `apiFetch<T>(path, { json?, method?, silent? })` in `@/lib/api`: sends JSON, toasts a translated error on failure and throws `ApiRequestError` (pass `silent: true` to handle it yourself).
- `@/lib/month` and `@/lib/period`: month and range labels in both locales, `todayLocal()`, `dayLabel()`.
- `formatMinor`, `splitEqual`, `parseAmountToMinor` come from `@yomi/core/money` on the client (the `@yomi/core` root is server-only).

## Testing UI changes

Add or extend a Playwright test in `e2e/` for user-visible flows (`pnpm e2e` runs on a fresh synthetic ledger), check both themes and a phone width (390 px), and switch the language to 中文 once to catch missing strings.
