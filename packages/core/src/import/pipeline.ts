import { accounts, backupDatabase, type Db, importBatches, settlements, transactions } from "@yomi/db";
import {
  bucketTotals,
  CodedError,
  type DeclaredBucket,
  type DeclaredTotals,
  type ErrorKind,
  type MessageParams,
  type NormalizedRow,
  type Notice,
  notice,
  type ParseResult,
  type SourceId,
} from "@yomi/importers";
import { and, desc, eq, gt, inArray } from "@yomi/db/orm";
import { runMatching } from "../capture/match";
import { capturesConfirmedBy, countReview } from "../capture/review";
import { detachFromAuthority } from "../capture/supersede";
import { autoSplitParticipants } from "../split/rules";
import { applySplit } from "../split/splits";
import { getTimeZone } from "../settings/time-zone";
import { occurredOnFor } from "../time/zone";
import type { CurrentUser } from "../user";
import { removeBatchBalances, statementBalances, upsertBalanceSnapshot } from "../assets/balances";
import { accountKey, accountMatchKey, type AccountSpec, fileAccountCurrency, loadAccountIds, resolveAccountSpec } from "./accounts";
import { resolveCategoryId } from "./categorize";
import { categoryContext, latestPurchaseCategories, loadCategorySources } from "./category-context";
import { statementCoverage } from "./coverage";
import { computeDedupKeys, sha256Hex } from "./dedup";
import { type LinkRow, planLinks } from "./link";
import { cleanMerchant } from "./merchant";

export type ParseFn = (bytes: Uint8Array, fileName: string) => Promise<ParseResult>;

export type BucketName = "expense" | "income" | "neutral";

export interface ReconciliationBucket {
  bucket: BucketName;
  declared: DeclaredBucket | null;
  parsed: DeclaredBucket;
  ok: boolean;
}

export interface Reconciliation {
  ok: boolean;
  count: { declared: number | null; parsed: number; ok: boolean };
  buckets: ReconciliationBucket[];
}

export interface CurrencySpending {
  currency: string;
  /** New rows counted as spending (expense/refund, status ok, not linked). */
  count: number;
  /** Σ −amount of those rows: positive = net spending. */
  spendingMinor: number;
}

export interface ParticipantSuggestion {
  lineNo: number;
  transactionId: number | null;
  merchant: string;
  participantIds: number[];
}

export interface ImportPreview {
  source: SourceId;
  fileName: string;
  fileHash: string;
  alreadyImported: boolean;
  existingBatchId: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  rowsTotal: number;
  newCount: number;
  dupCount: number;
  linkCount: number;
  closedCount: number;
  reconciliation: Reconciliation;
  spending: CurrencySpending[];
  accountsToCreate: AccountSpec[];
  participantSuggestions: ParticipantSuggestion[];
  /** New expense rows whose merchant has auto-split on; they are split equally on commit. */
  autoSplit: number;
  warnings: Notice[];
}

export interface ImportResult extends ImportPreview {
  batchId: number;
  inserted: number;
  skippedDup: number;
  linked: number;
  /** Pasted card alerts this import confirmed, and the size of the review queue after it. */
  captures: { linked: number; toReview: number };
}

export interface BatchSummary {
  id: number;
  source: string;
  fileName: string;
  fileHash: string;
  rowsTotal: number;
  rowsInserted: number;
  rowsSkippedDup: number;
  rowsLinked: number;
  declared: DeclaredTotals | null;
  parsed: DeclaredTotals | null;
  status: "committed" | "reverted";
  createdAt: string;
  revertedAt: string | null;
}

export interface RevertResult {
  batchId: number;
  deleted: number;
  keptEdited: number;
}

export class ImportError extends CodedError {
  constructor(kind: ErrorKind, code: string, message: string, params: MessageParams = {}) {
    super(kind, code, message, params);
    this.name = "ImportError";
  }
}

interface PlannedRow extends LinkRow {
  /** accountMatchKey of the spec: which ledger account the row lands on. */
  matchKey: string;
  dedupKey: string;
  merchant: string;
  categoryId: number | null;
  participantIds: number[] | null;
  /** Auto-split rule participants (non-self), when this new row will be split on commit. */
  autoSplitIds: number[] | null;
}

interface Plan {
  preview: ImportPreview;
  parsedTotals: DeclaredTotals;
  planned: PlannedRow[];
  existingAccountIds: Map<string, number>;
}

/** Row-level options for callers that are not a statement file (bank sync). */
export interface PlanOptions {
  /** The ledger account a row belongs to, when the caller already knows it. */
  accountSpec?: (row: NormalizedRow) => AccountSpec | null;
}

const CHUNK = 200;

function chunks<T>(xs: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function reconcile(declared: DeclaredTotals, parsed: DeclaredTotals): Reconciliation {
  const buckets: ReconciliationBucket[] = (["expense", "income", "neutral"] as const).map((bucket) => {
    const d = declared[bucket] ?? null;
    const p = parsed[bucket] ?? { count: 0, minor: 0 };
    return { bucket, declared: d, parsed: p, ok: d == null || (d.count === p.count && d.minor === p.minor) };
  });
  const declaredCount = declared.count ?? null;
  const parsedCount = parsed.count ?? 0;
  const count = { declared: declaredCount, parsed: parsedCount, ok: declaredCount == null || declaredCount === parsedCount };
  return { ok: count.ok && buckets.every((b) => b.ok), count, buckets };
}

function parseIds(v: unknown): number[] | null {
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : null;
}

/** Each row's account spec and dedup key, and the keys the ledger has already (those rows are duplicates). */
async function dedupRows(q: Db, user: CurrentUser, parsed: ParseResult, opts: PlanOptions): Promise<{ specs: AccountSpec[]; dedupKeys: string[]; existingKeys: Set<string> }> {
  const currency = fileAccountCurrency(parsed.source, parsed.rows);
  const specs = parsed.rows.map((r) => opts.accountSpec?.(r) ?? resolveAccountSpec(r, currency));
  // Dedup keys stay scoped by the spec's full identity; the row lands on the account its match key names.
  const dedupKeys = computeDedupKeys(parsed.rows, specs.map(accountKey));
  const existingKeys = new Set<string>();
  for (const part of chunks(dedupKeys)) {
    for (const r of (await q
      .select({ k: transactions.dedupKey })
      .from(transactions)
      .where(and(eq(transactions.userId, user.id), inArray(transactions.dedupKey, part)))
      )) {
      existingKeys.add(r.k);
    }
  }
  return { specs, dedupKeys, existingKeys };
}

async function buildPlan(q: Db, user: CurrentUser, parsed: ParseResult, fileHash: string, fileName: string, opts: PlanOptions = {}): Promise<Plan> {
  const userId = user.id;
  const warnings = [...parsed.warnings];
  const rows = parsed.rows;

  const existingBatch = (await q
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.userId, userId), eq(importBatches.fileHash, fileHash), eq(importBatches.status, "committed")))
    .limit(1))[0];

  const { specs, dedupKeys, existingKeys } = await dedupRows(q, user, parsed, opts);
  const existingAccountIds = await loadAccountIds(q, user);
  const toCreate = new Map<string, AccountSpec>();
  for (const s of specs) {
    const k = accountMatchKey(s);
    if (!existingAccountIds.has(k) && !toCreate.has(k)) toCreate.set(k, s);
  }

  // Categories and merchant rules
  const sources = await loadCategorySources(q, user);
  const fileCategoryByMerchant = new Map<string, number>();
  let dbCategoryByMerchant = new Map<string, number | null>();
  // Refunds inherit the category of an earlier purchase at the same merchant: this file's first, then the
  // ledger's latest. resolveCategoryId is synchronous, so the ledger lookups are loaded before refunds resolve.
  const ctx = categoryContext(sources, (m) => fileCategoryByMerchant.get(m) ?? dbCategoryByMerchant.get(m) ?? null);

  const planned: PlannedRow[] = rows.map((row, i) => ({
    row,
    spec: specs[i]!,
    matchKey: accountMatchKey(specs[i]!),
    dedupKey: dedupKeys[i]!,
    isDup: existingKeys.has(dedupKeys[i]!),
    merchant: cleanMerchant(row.counterparty),
    categoryId: null,
    duplicateOfId: null,
    linkBankId: null,
    participantIds: null,
    autoSplitIds: null,
  }));
  // Purchases first so refunds in the same file can inherit their category.
  for (const p of planned) {
    if (p.row.kind === "refund") continue;
    p.categoryId = resolveCategoryId(p.row, p.merchant, ctx);
    if (p.row.kind === "expense" && p.categoryId != null && p.merchant && !fileCategoryByMerchant.has(p.merchant)) {
      fileCategoryByMerchant.set(p.merchant, p.categoryId);
    }
  }
  dbCategoryByMerchant = await latestPurchaseCategories(
    q,
    user,
    planned.filter((p) => p.row.kind === "refund" && !fileCategoryByMerchant.has(p.merchant)).map((p) => p.merchant),
  );
  for (const p of planned) {
    if (p.row.kind === "refund") p.categoryId = resolveCategoryId(p.row, p.merchant, ctx);
  }
  for (const p of planned) {
    const ids = parseIds(sources.rules.get(p.merchant)?.participantIds ?? null);
    if (ids && ids.length > 0) p.participantIds = ids;
  }

  await planLinks(q, user, planned, warnings);

  // Whole-file basis, as the statement declares it (closed rows count, their amounts do not).
  const parsedTotals = bucketTotals(rows);
  const reconciliation = reconcile(parsed.declared, parsedTotals);
  if (!reconciliation.ok) {
    if (!reconciliation.count.ok) {
      warnings.push(
        notice(
          "import_reconcile_count",
          `Row count mismatch: the file declares ${reconciliation.count.declared}, parsed ${reconciliation.count.parsed}`,
          { declared: reconciliation.count.declared ?? 0, parsed: reconciliation.count.parsed },
        ),
      );
    }
    for (const b of reconciliation.buckets) {
      if (!b.ok && b.declared) {
        warnings.push(
          notice(
            "import_reconcile_bucket",
            `${b.bucket} totals mismatch: the file declares ${b.declared.count} rows ${b.declared.minor}, parsed ${b.parsed.count} rows ${b.parsed.minor} (minor units)`,
            {
              bucket: b.bucket,
              declaredCount: b.declared.count,
              declaredMinor: b.declared.minor,
              parsedCount: b.parsed.count,
              parsedMinor: b.parsed.minor,
            },
          ),
        );
      }
    }
  }

  const fresh = planned.filter((p) => !p.isDup);
  // Auto-split: same rows the unsplit triage would list (my own account, expense, ok, not linked).
  const autoRules = await autoSplitParticipants(q, user);
  for (const p of fresh) {
    if (p.row.kind !== "expense" || p.row.status !== "ok" || p.duplicateOfId != null || !p.merchant) continue;
    p.autoSplitIds = autoRules.get(p.merchant) ?? null;
  }
  const spendingMap = new Map<string, CurrencySpending>();
  for (const p of fresh) {
    if (p.duplicateOfId != null || p.row.status !== "ok") continue;
    if (p.row.kind !== "expense" && p.row.kind !== "refund") continue;
    const s = spendingMap.get(p.row.currency) ?? { currency: p.row.currency, count: 0, spendingMinor: 0 };
    s.count += 1;
    s.spendingMinor -= p.row.amountMinor;
    spendingMap.set(p.row.currency, s);
  }

  const preview: ImportPreview = {
    source: parsed.source,
    fileName,
    fileHash,
    alreadyImported: existingBatch != null,
    existingBatchId: existingBatch?.id ?? null,
    periodStart: parsed.periodStart ?? null,
    periodEnd: parsed.periodEnd ?? null,
    rowsTotal: rows.length,
    newCount: fresh.length,
    dupCount: planned.length - fresh.length,
    linkCount: fresh.filter((p) => p.duplicateOfId != null || p.linkBankId != null).length,
    closedCount: rows.filter((r) => r.status === "closed").length,
    reconciliation,
    spending: [...spendingMap.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    accountsToCreate: [...toCreate.values()],
    participantSuggestions: fresh
      .filter((p) => p.participantIds)
      .map((p) => ({ lineNo: p.row.lineNo, transactionId: null, merchant: p.merchant, participantIds: p.participantIds! })),
    autoSplit: fresh.filter((p) => p.autoSplitIds).length,
    warnings,
  };
  if (existingBatch) {
    warnings.push(notice("import_file_seen", `This file was imported in batch #${existingBatch.id}`, { batchId: existingBatch.id }));
  }
  return { preview, parsedTotals, planned, existingAccountIds };
}

/** Parses the file and reports what a commit would do. Writes nothing. */
export async function previewImport(
  db: Db,
  user: CurrentUser,
  parse: ParseFn,
  fileBytes: Uint8Array,
  fileName: string,
): Promise<ImportPreview> {
  const parsed = await parse(fileBytes, fileName);
  return (await buildPlan(db, user, parsed, sha256Hex(fileBytes), fileName)).preview;
}

/**
 * Imports a file in one DB transaction: creates accounts, inserts rows not seen before, links bank
 * rows to the Alipay/WeChat row they duplicate (both directions: new bank rows to existing wallet
 * rows, existing bank rows to new wallet rows), and records the batch. New expense rows of a merchant
 * with auto_split on are split equally with the rule's participants; other merchant-rule participant
 * suggestions are returned, never applied. Refuses a file already committed unless `force`.
 * A file DB is copied to backups/ first (reason pre-import) unless `backup: false`.
 */
export async function commitImport(
  db: Db,
  user: CurrentUser,
  parse: ParseFn,
  fileBytes: Uint8Array,
  fileName: string,
  opts: { force?: boolean; backup?: boolean } = {},
): Promise<ImportResult> {
  const parsed = await parse(fileBytes, fileName);
  return await commitParsed(db, user, parsed, { fileHash: sha256Hex(fileBytes), fileName, force: opts.force, backup: opts.backup });
}

export interface CommitParsedOptions extends PlanOptions {
  fileHash: string;
  fileName: string;
  force?: boolean;
  backup?: boolean;
  /** Store no declared totals: the source states none (bank APIs), so there is nothing to reconcile against. */
  noDeclared?: boolean;
  /** Plan first and write nothing (no backup, no batch) when no row is new; returns null then. */
  skipIfNothingNew?: boolean;
  /** Who the capture audit trail names for links this import makes; default `import:<batch id>`. */
  by?: string;
}

/** commitImport for rows that did not come from a file (bank sync) or were parsed already. */
export function commitParsed(db: Db, user: CurrentUser, parsed: ParseResult, opts: CommitParsedOptions & { skipIfNothingNew: true }): Promise<ImportResult | null>;
export function commitParsed(db: Db, user: CurrentUser, parsed: ParseResult, opts: CommitParsedOptions): Promise<ImportResult>;
export async function commitParsed(db: Db, user: CurrentUser, parsed: ParseResult, opts: CommitParsedOptions): Promise<ImportResult | null> {
  const userId = user.id;
  const { fileHash, fileName } = opts;
  if (opts.skipIfNothingNew) {
    const { dedupKeys, existingKeys } = await dedupRows(db, user, parsed, opts);
    if (dedupKeys.every((k) => existingKeys.has(k))) return null;
  }
  if (opts.backup !== false) await backupDatabase(db, "pre-import");
  return await db.transaction(async (tx) => {
    const { preview, parsedTotals, planned, existingAccountIds } = await buildPlan(tx, user, parsed, fileHash, fileName, opts);
    if (preview.alreadyImported && !opts.force) {
      throw new ImportError(
        "conflict",
        "import_already_imported",
        `The file was already imported (batch #${preview.existingBatchId}); use force to import it again`,
        { batchId: preview.existingBatchId ?? 0 },
      );
    }

    const coverage = statementCoverage(parsed.periodStart, parsed.periodEnd);
    const batch = (await tx
      .insert(importBatches)
      .values({
        userId,
        source: parsed.source,
        fileName,
        fileHash: preview.fileHash,
        rowsTotal: preview.rowsTotal,
        rowsInserted: preview.newCount,
        rowsSkippedDup: preview.dupCount,
        rowsLinked: preview.linkCount,
        declared: opts.noDeclared ? null : { ...parsed.declared },
        parsed: { ...parsedTotals },
        periodStart: coverage.start,
        periodEnd: coverage.end,
        status: "committed",
      })
      .returning({ id: importBatches.id })
      )[0]!;

    const accountIds = new Map(existingAccountIds);
    for (const spec of preview.accountsToCreate) {
      const a = (await tx
        .insert(accounts)
        .values({ userId, ...spec })
        .returning({ id: accounts.id })
        )[0]!;
      accountIds.set(accountMatchKey(spec), a.id);
    }

    // ICBC statements carry the card balance (账户余额) on every row: the last one is the closing balance.
    if (parsed.source === "icbc_pdf") {
      for (const b of statementBalances(
        planned.map((p) => ({ key: p.matchKey, row: p.row })),
        parsed.periodEnd,
      )) {
        const accountId = accountIds.get(b.key);
        if (accountId == null) continue;
        await upsertBalanceSnapshot(tx, user, {
          accountId,
          asOf: b.asOf,
          balanceMinor: b.balanceMinor,
          currency: b.currency,
          source: "statement",
          raw: { batchId: batch.id, line: b.lineNo },
        });
      }
    }

    const fresh = planned.filter((p) => !p.isDup);
    const zone = await getTimeZone(tx, user);
    const idByKey = new Map<string, number>();
    for (const part of chunks(fresh)) {
      const inserted = await tx
        .insert(transactions)
        .values(
          part.map((p) => ({
            userId,
            accountId: accountIds.get(p.matchKey) ?? null,
            occurredAt: p.row.occurredAt,
            occurredOn: occurredOnFor(p.row.occurredAt, p.row.source, zone),
            amountMinor: p.row.amountMinor,
            currency: p.row.currency,
            originalAmountMinor: p.row.originalAmountMinor,
            originalCurrency: p.row.originalCurrency,
            kind: p.row.kind,
            counterpartyRaw: p.row.counterparty,
            descriptionRaw: p.row.description,
            merchant: p.merchant,
            categoryId: p.categoryId,
            source: p.row.source,
            sourceRef: p.row.externalId,
            sourceCategory: p.row.sourceCategory,
            paymentMethod: p.row.paymentMethod,
            raw: p.row.raw,
            importBatchId: batch.id,
            dedupKey: p.dedupKey,
            duplicateOfId: p.duplicateOfId,
            status: p.row.status,
          })),
        )
        .returning({ id: transactions.id, dedupKey: transactions.dedupKey });
      for (const r of inserted) idByKey.set(r.dedupKey, r.id);
    }
    for (const p of fresh) {
      const walletId = idByKey.get(p.dedupKey);
      if (p.linkBankId == null || walletId == null) continue;
      await tx.update(transactions)
        .set({ duplicateOfId: walletId })
        .where(and(eq(transactions.userId, userId), eq(transactions.id, p.linkBankId)));
    }

    // Auto-split through the same code path as a chip tap (remainder to me, I paid), but not marked
    // as edited and not rewriting the rule, so reverting this batch still deletes these rows.
    let autoSplit = 0;
    for (const p of fresh) {
      const id = idByKey.get(p.dedupKey);
      if (!p.autoSplitIds || id == null) continue;
      await applySplit(tx, user, id, { participantIds: p.autoSplitIds, mode: "equal" }, { markEdited: false, rememberMerchant: false });
      autoSplit += 1;
    }

    // Pasted card alerts this file confirms: strict one-to-one, ties and near misses to the review queue.
    const matched = await runMatching(tx, user, { by: opts.by ?? `import:${batch.id}`, newAuthorityIds: [...idByKey.values()] });

    const participantSuggestions = fresh
      .filter((p) => p.participantIds)
      .map((p) => ({
        lineNo: p.row.lineNo,
        transactionId: idByKey.get(p.dedupKey) ?? null,
        merchant: p.merchant,
        participantIds: p.participantIds!,
      }));

    return {
      ...preview,
      participantSuggestions,
      autoSplit,
      batchId: batch.id,
      inserted: fresh.length,
      skippedDup: preview.dupCount,
      linked: preview.linkCount,
      captures: { linked: matched.linked, toReview: await countReview(tx, user) },
    };
  });
}

/**
 * Deletes the batch's transactions the user has not edited (splits cascade, settlements pointing at
 * them are removed, links from other rows are cleared) and marks the batch reverted. A file DB is
 * copied to backups/ first (reason pre-revert) unless `backup: false`.
 */
export async function revertBatch(db: Db, user: CurrentUser, batchId: number, opts: { backup?: boolean } = {}): Promise<RevertResult> {
  const userId = user.id;
  if (opts.backup !== false) await backupDatabase(db, "pre-revert");
  return await db.transaction(async (tx) => {
    const batch = (await tx
      .select()
      .from(importBatches)
      .where(and(eq(importBatches.userId, userId), eq(importBatches.id, batchId)))
      .limit(1))[0];
    if (!batch) throw new ImportError("not_found", "import_batch_not_found", `Batch #${batchId} does not exist`, { batchId });
    if (batch.status === "reverted") throw new ImportError("conflict", "import_batch_already_reverted", `Batch #${batchId} was already reverted`, { batchId });

    const rows = await tx
      .select({ id: transactions.id, userEditedAt: transactions.userEditedAt })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.importBatchId, batchId)));
    const ids = rows.filter((r) => r.userEditedAt == null).map((r) => r.id);
    // Card alerts these rows confirmed go back to provisional first, so a split alert gets its own amount back
    // instead of keeping a deleted statement's.
    for (const captureId of await capturesConfirmedBy(tx, user, ids)) await detachFromAuthority(tx, user, captureId, { by: `revert:${batchId}` });
    const parts = chunks(ids);
    for (const part of parts) {
      await tx.update(transactions)
        .set({ duplicateOfId: null })
        .where(and(eq(transactions.userId, userId), inArray(transactions.duplicateOfId, part)));
      await tx.delete(settlements)
        .where(and(eq(settlements.userId, userId), inArray(settlements.transactionId, part)));
    }
    for (const part of parts) {
      await tx.delete(transactions)
        .where(and(eq(transactions.userId, userId), inArray(transactions.id, part)));
    }
    await removeBatchBalances(tx, user, batchId);
    await tx.update(importBatches)
      .set({ status: "reverted", revertedAt: new Date().toISOString() })
      .where(and(eq(importBatches.userId, userId), eq(importBatches.id, batchId)));
    await runMatching(tx, user, { by: `revert:${batchId}` });
    return { batchId, deleted: ids.length, keptEdited: rows.length - ids.length };
  });
}

function parseTotals(v: unknown): DeclaredTotals | null {
  return v && typeof v === "object" ? (v as DeclaredTotals) : null;
}

/** Batches that inserted at least one row (a forced re-import of a known file adds nothing to undo). */
export async function listBatches(db: Db, user: CurrentUser): Promise<BatchSummary[]> {
  return (await db
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.userId, user.id), gt(importBatches.rowsInserted, 0)))
    .orderBy(desc(importBatches.id))
    )
    .map((b) => ({
      id: b.id,
      source: b.source,
      fileName: b.fileName,
      fileHash: b.fileHash,
      rowsTotal: b.rowsTotal,
      rowsInserted: b.rowsInserted,
      rowsSkippedDup: b.rowsSkippedDup,
      rowsLinked: b.rowsLinked,
      declared: parseTotals(b.declared),
      parsed: parseTotals(b.parsed),
      status: b.status,
      createdAt: b.createdAt,
      revertedAt: b.revertedAt,
    }));
}
