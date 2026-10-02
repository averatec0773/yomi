import { type AnyPgColumn, bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

// Postgres (PGlite locally, a server such as Neon later). Money = integer minor units + currency, stored as
// bigint read back as a JS number (sums in low-value currencies such as JPY/KRW can pass int4's 2^31; JS numbers
// stay exact to 2^53). Local dates = 'YYYY-MM-DD' text and timestamps = ISO 8601 text, compared as strings exactly
// as before (the time-zone logic depends on them). Booleans = boolean. JSON the code reads back = jsonb;
// write-only JSON (raw audit copies) stays text. Ids are identity columns (by default, so a migration can keep ids).

const now = () => new Date().toISOString();

const createdAt = () => text("created_at").notNull().$defaultFn(now);
const updatedAt = () => text("updated_at").notNull().$defaultFn(now).$onUpdateFn(now);

export const accounts = pgTable(
  "accounts",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["wallet", "debit_card", "credit_card", "cash", "other"] }).notNull(),
    institution: text("institution"),
    last4: text("last4"),
    currency: text("currency").notNull(),
    /** Balance (account currency, minor units) the user set at the end of `starting_balance_on`; transactions after it are added (Assets). */
    startingBalanceMinor: bigint("starting_balance_minor", { mode: "number" }),
    startingBalanceOn: text("starting_balance_on"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("accounts_user_kind_inst_last4_name_uq").on(t.userId, t.kind, t.institution, t.last4, t.name)],
);

export const categories = pgTable(
  "categories",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["expense", "income"] }).notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    archivedAt: text("archived_at"),
  },
  (t) => [uniqueIndex("categories_user_name_uq").on(t.userId, t.name)],
);

export const importBatches = pgTable("import_batches", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("user_id").notNull(),
  source: text("source").notNull(),
  fileName: text("file_name").notNull(),
  fileHash: text("file_hash").notNull(),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsInserted: integer("rows_inserted").notNull().default(0),
  rowsSkippedDup: integer("rows_skipped_dup").notNull().default(0),
  rowsLinked: integer("rows_linked").notNull().default(0),
  declared: jsonb("declared").$type<Record<string, unknown>>(),
  parsed: jsonb("parsed").$type<Record<string, unknown>>(),
  status: text("status", { enum: ["committed", "reverted"] }).notNull().default("committed"),
  createdAt: createdAt(),
  revertedAt: text("reverted_at"),
});

export const transactions = pgTable(
  "transactions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    accountId: integer("account_id").references(() => accounts.id),
    occurredAt: text("occurred_at").notNull(),
    /**
     * Calendar day 'YYYY-MM-DD' of occurred_at in the user's time zone (core occurredOnFor); every date
     * filter and grouping reads this. Core writes it; an insert that leaves it '' gets the source's own
     * date from a trigger (migration 0008).
     */
    occurredOn: text("occurred_on").notNull().default(""),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    originalAmountMinor: bigint("original_amount_minor", { mode: "number" }),
    originalCurrency: text("original_currency"),
    kind: text("kind", { enum: ["expense", "income", "transfer", "refund"] }).notNull(),
    counterpartyRaw: text("counterparty_raw").notNull().default(""),
    descriptionRaw: text("description_raw").notNull().default(""),
    merchant: text("merchant").notNull().default(""),
    categoryId: integer("category_id").references(() => categories.id),
    note: text("note"),
    /** A note written for the people this row is shared with; shown on their statement. `note` stays private. */
    sharedNote: text("shared_note"),
    source: text("source", { enum: ["alipay", "wechat", "icbc_pdf", "plaid", "boa_csv", "sms", "manual"] }).notNull(),
    sourceRef: text("source_ref"),
    sourceCategory: text("source_category"),
    paymentMethod: text("payment_method"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    importBatchId: integer("import_batch_id").references(() => importBatches.id),
    dedupKey: text("dedup_key").notNull(),
    duplicateOfId: integer("duplicate_of_id").references((): AnyPgColumn => transactions.id),
    status: text("status", { enum: ["ok", "closed"] }).notNull().default("ok"),
    userEditedAt: text("user_edited_at"),
    /** Set when the user said "not this one" to the row's split suggestion; the row gets no suggestion while set. */
    splitSuggestionDismissedAt: text("split_suggestion_dismissed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("transactions_user_dedup_key_uq").on(t.userId, t.dedupKey),
    index("transactions_user_occurred_at_idx").on(t.userId, t.occurredAt),
    index("transactions_user_occurred_on_idx").on(t.userId, t.occurredOn),
  ],
);

export const participants = pgTable(
  "participants",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    isSelf: boolean("is_self").notNull().default(false),
    aliases: text("aliases").notNull().default("[]"),
    archivedAt: text("archived_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("participants_user_name_uq").on(t.userId, t.name)],
);

export const transactionSplits = pgTable(
  "transaction_splits",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id),
    currency: text("currency").notNull(),
    owedMinor: bigint("owed_minor", { mode: "number" }).notNull(),
    paidMinor: bigint("paid_minor", { mode: "number" }).notNull().default(0),
    method: text("method", { enum: ["equal", "exact"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("transaction_splits_tx_participant_uq").on(t.transactionId, t.participantId)],
);

export const settlements = pgTable("settlements", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("user_id").notNull(),
  participantId: integer("participant_id")
    .notNull()
    .references(() => participants.id),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  originalAmountMinor: bigint("original_amount_minor", { mode: "number" }),
  originalCurrency: text("original_currency"),
  /** Decimal string: units of original_currency per 1 unit of currency (e.g. "7.2"). Null without an original amount. */
  fxRate: text("fx_rate"),
  settledOn: text("settled_on").notNull(),
  note: text("note"),
  transactionId: integer("transaction_id").references(() => transactions.id),
  /** 'payment': money changed hands. 'opening': an opening balance, not a payment. */
  kind: text("kind", { enum: ["payment", "opening"] }).notNull().default("payment"),
  /** Kind of the linked transaction before the settlement flipped it to transfer; restored on delete. */
  priorKind: text("prior_kind", { enum: ["expense", "income", "transfer", "refund"] }),
  createdAt: createdAt(),
});

/**
 * Split items a settlement paid off. amount_minor is signed like the item's balance delta (+ they owed me) and
 * is the part of that item this settlement covers; a settlement's items sum to its amount.
 */
export const settlementItems = pgTable(
  "settlement_items",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    settlementId: integer("settlement_id")
      .notNull()
      .references(() => settlements.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("settlement_items_settlement_tx_uq").on(t.settlementId, t.transactionId),
    index("settlement_items_participant_idx").on(t.participantId),
  ],
);

export const merchantRules = pgTable(
  "merchant_rules",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    merchant: text("merchant").notNull(),
    categoryId: integer("category_id").references(() => categories.id),
    participantIds: jsonb("participant_ids").$type<number[]>(),
    /** 1: new imported expense rows of this merchant are split equally with me + participant_ids. */
    autoSplit: boolean("auto_split").notNull().default(false),
    /** false: "don't suggest splits for this merchant" (no dashed suggestion from the merchant or its category). */
    suggest: boolean("suggest").notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("merchant_rules_user_merchant_uq").on(t.userId, t.merchant)],
);

/** Per-user preferences as key → text value (e.g. timeZone). */
export const userSettings = pgTable(
  "user_settings",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("user_settings_user_key_uq").on(t.userId, t.key)],
);

export const monthlyTargets = pgTable("monthly_targets", {
  id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
  userId: integer("user_id").notNull(),
  month: text("month"),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    name: text("name").notNull(),
    cursor: text("cursor"),
    status: text("status", { enum: ["idle", "running", "failed"] }).notNull().default("idle"),
    runAfter: text("run_after"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("jobs_user_name_uq").on(t.userId, t.name)],
);

/**
 * One bank login (a Plaid Item) made through an aggregator. The access token stays in this local DB.
 * `cursor` is the provider's incremental sync cursor (Plaid /transactions/sync is per Item).
 */
export const bankConnections = pgTable(
  "bank_connections",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    provider: text("provider", { enum: ["plaid"] }).notNull(),
    /** bank: transactions sync into the ledger; brokerage: investments (holdings) only, never transactions sync. */
    kind: text("kind", { enum: ["bank", "brokerage"] }).notNull().default("bank"),
    enrollmentId: text("enrollment_id").notNull(),
    institutionName: text("institution_name"),
    accessToken: text("access_token").notNull(),
    status: text("status", { enum: ["active", "paused", "disconnected", "error"] }).notNull().default("active"),
    lastError: text("last_error"),
    lastSyncedAt: text("last_synced_at"),
    createdAt: createdAt(),
    cursor: text("cursor"),
  },
  (t) => [uniqueIndex("bank_connections_user_provider_enrollment_uq").on(t.userId, t.provider, t.enrollmentId)],
);

/**
 * Every Plaid Link token yomi hands out, persisted at creation so an Item Plaid creates in that
 * session can be recovered server side (/link/token/get) even when the browser never delivers a
 * public token (closed Link early, reload). `exchanged` is a JSON array of sha256(public token)
 * already traded for an access token; `link_session_id` is Plaid's id from onExit or /link/token/get.
 */
export const plaidLinkSessions = pgTable(
  "plaid_link_sessions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    linkToken: text("link_token").notNull(),
    environment: text("environment").notNull(),
    purpose: text("purpose", { enum: ["new", "update"] }).notNull(),
    /** What a login made in this session becomes: a bank connection or a brokerage (investments) connection. */
    kind: text("kind", { enum: ["bank", "brokerage"] }).notNull().default("bank"),
    connectionId: integer("connection_id").references(() => bankConnections.id),
    status: text("status", { enum: ["open", "completed", "recovered", "abandoned", "expired"] }).notNull().default("open"),
    linkSessionId: text("link_session_id"),
    exchanged: jsonb("exchanged").$type<unknown[]>(),
    createdAt: createdAt(),
    checkedAt: text("checked_at"),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("plaid_link_sessions_link_token_uq").on(t.linkToken), index("plaid_link_sessions_user_status_idx").on(t.userId, t.status)],
);

/** A provider account inside a connection, mapped to a ledger account. `cursor` is unused since Plaid (per-Item cursor). */
export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => bankConnections.id),
    providerAccountId: text("provider_account_id").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    type: text("type").notNull(),
    subtype: text("subtype"),
    lastFour: text("last_four"),
    currency: text("currency").notNull(),
    cursor: text("cursor"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("bank_accounts_connection_provider_account_uq").on(t.connectionId, t.providerAccountId)],
);

export const IDENTITY_KINDS = ["wechat", "alipay", "zelle_name", "zelle_email", "zelle_phone", "venmo", "bank_name", "other"] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];

/**
 * How a participant shows up in payment apps and bank text: a typed value plus its normalized form
 * (lowercase, trimmed, spaces collapsed; phone digits only; see core normalizeIdentity). One
 * (kind, normalized) belongs to one participant. Replaces `participants.aliases`, which migration
 * 0006 copied here; the column stays readable but is no longer written.
 */
export const participantIdentities = pgTable(
  "participant_identities",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    participantId: integer("participant_id")
      .notNull()
      .references(() => participants.id),
    kind: text("kind", { enum: IDENTITY_KINDS }).notNull(),
    value: text("value").notNull(),
    normalized: text("normalized").notNull(),
    source: text("source", { enum: ["manual", "claimed"] }).notNull().default("manual"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("participant_identities_user_kind_normalized_uq").on(t.userId, t.kind, t.normalized),
    index("participant_identities_participant_idx").on(t.participantId),
  ],
);

/** Person-to-person counterparties the user chose not to track ("Ignore"). */
export const counterpartyIgnores = pgTable(
  "counterparty_ignores",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    kind: text("kind", { enum: IDENTITY_KINDS }).notNull(),
    normalized: text("normalized").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("counterparty_ignores_user_kind_normalized_uq").on(t.userId, t.kind, t.normalized)],
);

export const INVEST_PROVIDERS = ["ibkr", "plaid"] as const;
export type InvestProviderId = (typeof INVEST_PROVIDERS)[number];
export const INVEST_TXN_TYPES = ["buy", "sell", "dividend", "interest", "fee", "transfer", "other"] as const;
export type InvestTxnType = (typeof INVEST_TXN_TYPES)[number];

/**
 * A brokerage account read from a provider (IBKR Flex statement account, Plaid investment account).
 * `external_id` is the provider's id (IBKR account id, Plaid account_id); `bank_connection_id` links a
 * Plaid account to its Item. `currency` is the account's base currency.
 */
export const investmentAccounts = pgTable(
  "investment_accounts",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    provider: text("provider", { enum: INVEST_PROVIDERS }).notNull(),
    externalId: text("external_id").notNull(),
    bankConnectionId: integer("bank_connection_id").references(() => bankConnections.id),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("investment_accounts_user_provider_external_uq").on(t.userId, t.provider, t.externalId)],
);

/** An instrument as the provider identifies it (IBKR conid, Plaid security_id). Decimals are strings. */
export const securities = pgTable(
  "securities",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    provider: text("provider", { enum: INVEST_PROVIDERS }).notNull(),
    externalId: text("external_id").notNull(),
    symbol: text("symbol"),
    name: text("name"),
    type: text("type"),
    currency: text("currency").notNull(),
    isin: text("isin"),
    cusip: text("cusip"),
    /** Contract multiplier as a decimal string (options usually "100"); null means 1. */
    multiplier: text("multiplier"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("securities_user_provider_external_uq").on(t.userId, t.provider, t.externalId)],
);

/**
 * One position (or one currency of cash, security_id null) of an account on `as_of` (YYYY-MM-DD).
 * `position_key` is `sec:<security id>` or `cash:<currency>`, so cash rows are unique too; a re-run on
 * the same day replaces that day's rows. quantity and price are the source's exact decimal strings.
 */
export const holdingSnapshots = pgTable(
  "holding_snapshots",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    investmentAccountId: integer("investment_account_id")
      .notNull()
      .references(() => investmentAccounts.id),
    securityId: integer("security_id").references(() => securities.id),
    positionKey: text("position_key").notNull(),
    asOf: text("as_of").notNull(),
    quantity: text("quantity").notNull(),
    price: text("price").notNull(),
    marketValueMinor: bigint("market_value_minor", { mode: "number" }).notNull(),
    costBasisMinor: bigint("cost_basis_minor", { mode: "number" }),
    currency: text("currency").notNull(),
    sourceRaw: text("source_raw"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("holding_snapshots_account_position_as_of_uq").on(t.investmentAccountId, t.positionKey, t.asOf),
    index("holding_snapshots_user_as_of_idx").on(t.userId, t.asOf),
  ],
);

/** Trades and cash activity of an investment account. amount_minor: positive = cash into the account. */
export const investmentTransactions = pgTable(
  "investment_transactions",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    investmentAccountId: integer("investment_account_id")
      .notNull()
      .references(() => investmentAccounts.id),
    securityId: integer("security_id").references(() => securities.id),
    externalId: text("external_id").notNull(),
    date: text("date").notNull(),
    type: text("type", { enum: INVEST_TXN_TYPES }).notNull(),
    quantity: text("quantity"),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    description: text("description"),
    raw: text("raw"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("investment_transactions_account_external_uq").on(t.investmentAccountId, t.externalId),
    index("investment_transactions_user_date_idx").on(t.userId, t.date),
  ],
);

/**
 * Net asset value of an investment account at the close of `as_of` (YYYY-MM-DD), in `currency` (the
 * provider's base currency for the account): IBKR Flex "Net Asset Value (NAV) in Base" daily rows. It fills
 * the investments history on days without holding snapshots (snapshots win on days that have both). A
 * re-pull overwrites the same day. `raw` keeps the row's attributes as JSON.
 */
export const investmentDailyNav = pgTable(
  "investment_daily_nav",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    investmentAccountId: integer("investment_account_id")
      .notNull()
      .references(() => investmentAccounts.id),
    asOf: text("as_of").notNull(),
    totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    raw: text("raw"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("investment_daily_nav_account_as_of_uq").on(t.investmentAccountId, t.asOf),
    index("investment_daily_nav_user_as_of_idx").on(t.userId, t.asOf),
  ],
);

export const BALANCE_SOURCES = ["plaid", "statement", "derived", "manual"] as const;
export type BalanceSource = (typeof BALANCE_SOURCES)[number];

/**
 * Balance of a ledger account in one currency at the end of `as_of` (YYYY-MM-DD). Signed: money I
 * have is positive, card debt is negative. Sources: plaid (bank balance during sync), statement (ICBC
 * 账户余额), derived (starting balance + transactions, or a daily carry-forward), manual (a balance
 * the user typed). A later write for the same day replaces the row. `raw` is JSON or null.
 */
export const accountBalanceSnapshots = pgTable(
  "account_balance_snapshots",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    userId: integer("user_id").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    asOf: text("as_of").notNull(),
    balanceMinor: bigint("balance_minor", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    source: text("source", { enum: BALANCE_SOURCES }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("account_balance_snapshots_account_as_of_currency_uq").on(t.accountId, t.asOf, t.currency),
    index("account_balance_snapshots_user_as_of_idx").on(t.userId, t.asOf),
  ],
);
