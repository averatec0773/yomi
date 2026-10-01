import { createHandler } from "@yomi/api";
import { getDb } from "@/lib/db";
import { e2eFlexFetch, e2ePlaidFetch } from "@/lib/e2e-fakes";

export const runtime = "nodejs";

// YOMI_E2E=1 (Playwright's servers only): IBKR Flex calls and Plaid's "Test keys" go to in-process fakes.
const e2e = process.env.YOMI_E2E === "1";
const handler = createHandler({
  getDb,
  invest: e2e ? { ibkrFlex: { fetch: e2eFlexFetch } } : undefined,
  secrets: e2e ? { plaidFetch: e2ePlaidFetch } : undefined,
});

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
