import {
  AcceptSuggestionsBody,
  AcceptSuggestionsResult,
  ApplyAutoSplitBody,
  ApplyAutoSplitResult,
  BalanceList,
  BulkToggleBody,
  BulkToggleResult,
  CandidateList,
  ClaimCounterpartyBody,
  ClaimCounterpartyResult,
  ClearBeforeBody,
  CreatedEntry,
  CreateParticipantBody,
  DismissSuggestionBody,
  DismissSuggestionResult,
  DeleteIdentityResult,
  DeleteSettlementResult,
  FriendPaidBody,
  Identity,
  IdentityInput,
  IgnoreCounterpartyResult,
  MarkSettlementBody,
  MerchantRule,
  MerchantRuleList,
  MerchantSuggestBody,
  MerchantSuggestResult,
  OpenItemList,
  OpenItemsQuery,
  OpeningBalanceBody,
  Participant,
  ParticipantList,
  PatchParticipantBody,
  RecordSettlementBody,
  RevertSuggestionsResult,
  SetAutoSplitBody,
  SetSplitBody,
  Settlement,
  SettleAllBody,
  SettlementList,
  SharedNote,
  SharedNoteBody,
  SplitResult,
  Statement,
  StatementQuery,
  SuggestionList,
  ToggleParticipantBody,
  UnclaimedCounterpartyList,
  UnsplitSummary,
} from "@yomi/contracts";
import {
  CodedError,
  type MessageParams,
  acceptSuggestions,
  addIdentity,
  applyAutoSplitToExisting,
  archiveParticipant,
  balances,
  bulkToggle,
  claimCounterparty,
  clearBefore,
  createFriendPaidExpense,
  createParticipant,
  deleteSettlement,
  dismissSplitSuggestion,
  getCurrentUser,
  getSharedNote,
  getSplit,
  ignoreCounterparty,
  listMerchantRules,
  listParticipants,
  listSettlements,
  listUnclaimedCounterparties,
  markAsSettlement,
  openItems,
  recordOpeningBalance,
  recordSettlement,
  removeIdentity,
  renameParticipant,
  revertAcceptedSuggestions,
  setAutoSplit,
  setMerchantSuggest,
  setSharedNote,
  setSplit,
  settleAll,
  settlementCandidates,
  statementText,
  toggleParticipantResult,
  unsplitSuggestions,
  unsplitSummary,
} from "@yomi/core";
import type { Db } from "@yomi/db";
import { type Context, Hono } from "hono";

interface Schema<T> {
  safeParse(
    v: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** Thrown by `readJson`/`readQuery`: a request the route cannot read (400). */
export class BadRequest extends CodedError {
  constructor(code: string, message: string, params: MessageParams = {}) {
    super("invalid", code, message, params);
    this.name = "BadRequest";
  }
}

function issuesText(issues: { path: PropertyKey[]; message: string }[], root: string): string {
  return issues.map((i) => `${i.path.map(String).join(".") || root}: ${i.message}`).join("; ");
}

export async function readJson<T>(c: Context, schema: Schema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequest("invalid_json", "The request body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = issuesText(parsed.error.issues, "body");
    throw new BadRequest("validation_failed", `Invalid request: ${details}`, { details });
  }
  return parsed.data;
}

export function readQuery<T>(c: Context, schema: Schema<T>): T {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const details = issuesText(parsed.error.issues, "query");
    throw new BadRequest("validation_failed", `Invalid request: ${details}`, { details });
  }
  return parsed.data;
}

export function idParam(c: Context, name = "id"): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new BadRequest("invalid_id", `Invalid ${name}`, { name });
  return id;
}

export function splitRoutes(deps: { getDb: () => Db | Promise<Db> }): Hono {
  const r = new Hono();
  const db = async () => await deps.getDb();
  const user = () => getCurrentUser();

  // participants
  r.get("/participants", async (c) => {
    const includeArchived = ["1", "true"].includes(c.req.query("includeArchived") ?? "");
    return c.json({ participants: await listParticipants(await db(), user(), { includeArchived }) } satisfies ParticipantList);
  });
  r.post("/participants", async (c) => {
    const body = await readJson(c, CreateParticipantBody);
    return c.json((await createParticipant(await db(), user(), body.name, body.identities)) satisfies Participant, 201);
  });
  r.patch("/participants/:id", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, PatchParticipantBody);
    const out = await (await db()).transaction(async (q) => {
      if (body.name !== undefined) await renameParticipant(q, user(), id, body.name);
      if (body.archived !== undefined) await archiveParticipant(q, user(), id, body.archived);
      return (await listParticipants(q, user(), { includeArchived: true })).find((p) => p.id === id)!;
    });
    return c.json(out satisfies Participant);
  });
  r.post("/participants/:id/identities", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, IdentityInput);
    return c.json((await addIdentity(await db(), user(), id, body)) satisfies Identity, 201);
  });
  r.delete("/identities/:id", async (c) => {
    await removeIdentity(await db(), user(), idParam(c));
    return c.json({ deleted: true } satisfies DeleteIdentityResult);
  });

  // person-to-person counterparties not yet bound to anyone
  r.get("/split/counterparties", async (c) =>
    c.json({ counterparties: await listUnclaimedCounterparties(await db(), user()) } satisfies UnclaimedCounterpartyList),
  );
  r.post("/split/counterparties/claim", async (c) => {
    const body = await readJson(c, ClaimCounterpartyBody);
    return c.json((await claimCounterparty(await db(), user(), body)) satisfies ClaimCounterpartyResult, 201);
  });
  r.post("/split/counterparties/ignore", async (c) => {
    const body = await readJson(c, IdentityInput);
    await ignoreCounterparty(await db(), user(), body);
    return c.json({ ignored: true } satisfies IgnoreCounterpartyResult);
  });

  // splits
  r.get("/transactions/:id/split", async (c) => c.json({ split: await getSplit(await db(), user(), idParam(c)) } satisfies SplitResult));
  r.post("/transactions/:id/split", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, SetSplitBody);
    return c.json({ split: await setSplit(await db(), user(), id, body) } satisfies SplitResult);
  });
  r.post("/transactions/:id/toggle-participant", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, ToggleParticipantBody);
    return c.json((await toggleParticipantResult(await db(), user(), id, body.participantId)) satisfies SplitResult);
  });
  r.post("/split/bulk-toggle", async (c) => {
    const body = await readJson(c, BulkToggleBody);
    return c.json((await bulkToggle(await db(), user(), body.transactionIds, body.participantId, body.on)) satisfies BulkToggleResult);
  });
  r.get("/split/balances", async (c) => c.json({ balances: await balances(await db(), user()) } satisfies BalanceList));

  // settlements
  r.get("/settlements", async (c) => {
    const pid = c.req.query("participantId");
    const participantId = pid === undefined || pid === "" ? undefined : Number(pid);
    if (participantId !== undefined && !(Number.isInteger(participantId) && participantId > 0)) {
      throw new BadRequest("invalid_id", "Invalid participantId", { name: "participantId" });
    }
    return c.json({ settlements: await listSettlements(await db(), user(), participantId) } satisfies SettlementList);
  });
  r.post("/settlements", async (c) => {
    const body = await readJson(c, RecordSettlementBody);
    return c.json((await recordSettlement(await db(), user(), body)) satisfies Settlement, 201);
  });
  r.delete("/settlements/:id", async (c) =>
    c.json((await deleteSettlement(await db(), user(), idParam(c))) satisfies DeleteSettlementResult),
  );
  r.post("/split/settle-all", async (c) => {
    const { participantId, currency, ...rest } = await readJson(c, SettleAllBody);
    return c.json((await settleAll(await db(), user(), participantId, currency, rest)) satisfies Settlement, 201);
  });
  r.post("/split/opening-balance", async (c) => {
    const body = await readJson(c, OpeningBalanceBody);
    return c.json((await recordOpeningBalance(await db(), user(), body)) satisfies Settlement, 201);
  });
  r.post("/split/clear-before", async (c) => {
    const { participantId, currency, from, note } = await readJson(c, ClearBeforeBody);
    return c.json((await clearBefore(await db(), user(), participantId, currency, from, note)) satisfies Settlement, 201);
  });
  r.get("/split/candidates", async (c) => c.json({ candidates: await settlementCandidates(await db(), user()) } satisfies CandidateList));
  r.post("/transactions/:id/mark-settlement", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, MarkSettlementBody);
    return c.json((await markAsSettlement(await db(), user(), id, body)) satisfies Settlement, 201);
  });

  // friend-paid, statement, suggestions
  r.post("/split/friend-paid", async (c) => {
    const body = await readJson(c, FriendPaidBody);
    return c.json((await createFriendPaidExpense(await db(), user(), body)) satisfies CreatedEntry, 201);
  });
  r.get("/split/statement", async (c) => {
    const q = readQuery(c, StatementQuery);
    return c.json(
      (await statementText(await db(), user(), q.participantId, q.currency, {
        since: q.since,
        recentSince: q.recentSince,
        locale: q.locale,
        scope: q.scope,
        itemIds: q.items,
        show: q.show,
      })) satisfies Statement,
    );
  });
  r.get("/split/open-items", async (c) => {
    const q = readQuery(c, OpenItemsQuery);
    return c.json({ items: await openItems(await db(), user(), q.participantId, q.currency) } satisfies OpenItemList);
  });
  r.get("/transactions/:id/shared-note", async (c) => c.json((await getSharedNote(await db(), user(), idParam(c))) satisfies SharedNote));
  r.put("/transactions/:id/shared-note", async (c) => {
    const id = idParam(c);
    const body = await readJson(c, SharedNoteBody);
    return c.json((await setSharedNote(await db(), user(), id, body.sharedNote)) satisfies SharedNote);
  });
  r.get("/split/suggestions", async (c) => {
    const month = c.req.query("month");
    if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) throw new BadRequest("invalid_month", "month must be YYYY-MM", { value: month });
    return c.json({ suggestions: await unsplitSuggestions(await db(), user(), { month }) } satisfies SuggestionList);
  });
  r.post("/split/accept-suggestions", async (c) => {
    const { transactionIds } = await readJson(c, AcceptSuggestionsBody);
    return c.json((await acceptSuggestions(await db(), user(), transactionIds)) satisfies AcceptSuggestionsResult);
  });
  r.post("/split/accept-suggestions/undo", async (c) => {
    const { transactionIds } = await readJson(c, AcceptSuggestionsBody);
    return c.json((await revertAcceptedSuggestions(await db(), user(), transactionIds)) satisfies RevertSuggestionsResult);
  });
  r.post("/transactions/:id/split-suggestion/dismiss", async (c) => {
    const id = idParam(c);
    const { dismissed } = await readJson(c, DismissSuggestionBody);
    return c.json((await dismissSplitSuggestion(await db(), user(), id, dismissed)) satisfies DismissSuggestionResult);
  });
  r.get("/split/unsplit-summary", async (c) => c.json({ months: await unsplitSummary(await db(), user()) } satisfies UnsplitSummary));

  // merchant rules: auto-split
  r.get("/merchant-rules", async (c) => {
    const autoSplitOnly = ["1", "true"].includes(c.req.query("autoSplit") ?? "");
    return c.json({ rules: await listMerchantRules(await db(), user(), { autoSplitOnly }) } satisfies MerchantRuleList);
  });
  r.post("/merchant-rules/auto-split", async (c) => {
    const { merchant, ...body } = await readJson(c, SetAutoSplitBody);
    return c.json((await setAutoSplit(await db(), user(), merchant, body)) satisfies MerchantRule);
  });
  r.post("/merchant-rules/suggest", async (c) => {
    const { merchant, ...body } = await readJson(c, MerchantSuggestBody);
    return c.json((await setMerchantSuggest(await db(), user(), merchant, body)) satisfies MerchantSuggestResult);
  });
  r.post("/merchant-rules/apply-auto-split", async (c) => {
    const { merchant } = await readJson(c, ApplyAutoSplitBody);
    return c.json((await applyAutoSplitToExisting(await db(), user(), merchant)) satisfies ApplyAutoSplitResult);
  });

  return r;
}
