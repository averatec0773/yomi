import { createHandler } from "@yomi/api";
import { getDb } from "@/lib/db";
import { e2eFlexFetch, e2ePlaidFetch } from "@/lib/e2e-fakes";

export const runtime = "nodejs";

// YOMI_E2E=1 (Playwright's servers only): IBKR Flex calls and Plaid's "Test keys" go to in-process fakes. The Flex
// fake answers at once, so the client skips its 5 s pause before the first GetStatement.
const e2e = process.env.YOMI_E2E === "1";
const handler = createHandler({
  getDb,
  invest: e2e ? { ibkrFlex: { fetch: e2eFlexFetch, initialDelayMs: 0 } } : undefined,
  secrets: e2e ? { plaidFetch: e2ePlaidFetch } : undefined,
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
