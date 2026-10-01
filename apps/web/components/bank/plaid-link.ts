import type { BankEnvironment, LinkExitBody } from "@yomi/contracts";
import { toast } from "sonner";
import { fmt } from "@/i18n/format";
import { getClientDictionary } from "@/i18n/client";
import { savePending } from "./pending-exchange";

// Plaid Link must be loaded from Plaid's CDN, never bundled (https://plaid.com/docs/link/web/).
const LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export interface PlaidLinkMetadata {
  institution: { name: string; institution_id: string } | null;
  accounts?: { id: string; name: string; mask: string | null }[];
}

interface PlaidLinkError {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

/** onExit metadata (https://plaid.com/docs/link/web/#onexit). */
interface PlaidExitMetadata {
  institution: { name: string; institution_id: string } | null;
  /** Where the user stopped, e.g. requires_credentials, institution_not_found, choose_device. */
  status?: string | null;
  link_session_id?: string;
  request_id?: string;
}

/** onEvent metadata (https://plaid.com/docs/link/web/#onevent). */
interface PlaidEventMetadata {
  error_type?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  exit_status?: string | null;
  institution_name?: string | null;
  link_session_id?: string;
  request_id?: string;
  view_name?: string | null;
}

interface PlaidHandler {
  open(): void;
  destroy(): void;
}
interface PlaidGlobal {
  create(config: {
    token: string;
    onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
    onExit?: (error: PlaidLinkError | null, metadata: PlaidExitMetadata) => void;
    onEvent?: (eventName: string, metadata: PlaidEventMetadata) => void;
  }): PlaidHandler;
}

let loading: Promise<PlaidGlobal> | null = null;

function loadPlaid(): Promise<PlaidGlobal> {
  const w = window as unknown as { Plaid?: PlaidGlobal };
  if (w.Plaid) return Promise.resolve(w.Plaid);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = LINK_SRC;
    s.async = true;
    s.onload = () => (w.Plaid ? resolve(w.Plaid) : reject(new Error(getClientDictionary().bank.plaid.loadFailed)));
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error(getClientDictionary().bank.plaid.network));
    };
    document.body.appendChild(s);
  });
  return loading;
}

/** Sends Link diagnostics to the dev server log (POST /api/bank/link-exit); failures are ignored. */
function report(body: LinkExitBody): void {
  void fetch("/api/bank/link-exit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

/** How Link closed without onSuccess; drives server-side recovery of an Item created anyway. */
export interface LinkExitInfo {
  status: string | null;
  linkSessionId: string | null;
  /** Plaid reported the bank login as done (exit status or a CONNECTED view): an Item may exist. */
  connected: boolean;
  errorCode: string | null;
}

/**
 * Opens Plaid Link with a fresh link token. Resolves with the public token and metadata on success,
 * null when the user closes the window (a neutral toast says where they stopped); rejects when Link
 * reports an error on exit. Errors and ERROR events are logged to the console and the server.
 */
export async function openPlaidLink(
  linkToken: string,
  opts: { pendingEnvironment?: BankEnvironment; sessionId?: number; onExit?: (info: LinkExitInfo) => void } = {},
): Promise<{ publicToken: string; metadata: PlaidLinkMetadata } | null> {
  const Plaid = await loadPlaid();
  // A reload while Link is open loses onSuccess (and on the Trial plan burns the Item): warn first.
  const guard = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = "";
  };
  window.addEventListener("beforeunload", guard);
  const unguard = () => window.removeEventListener("beforeunload", guard);
  let sawConnected = false;
  let lastSessionId: string | null = null;
  return new Promise((resolve, reject) => {
    const handler = Plaid.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        // New logins: persist the public token first, so a reload before the exchange can resume it.
        if (opts.pendingEnvironment) {
          savePending({
            publicToken,
            institution: metadata.institution,
            environment: opts.pendingEnvironment,
            at: new Date().toISOString(),
            sessionId: opts.sessionId,
          });
        }
        unguard();
        handler.destroy();
        resolve({ publicToken, metadata });
      },
      onExit: (err, metadata) => {
        unguard();
        handler.destroy();
        const institution = metadata?.institution?.name ?? null;
        const status = metadata?.status ?? null;
        opts.onExit?.({
          status,
          linkSessionId: metadata?.link_session_id ?? lastSessionId,
          connected: sawConnected || /connected/i.test(status ?? ""),
          errorCode: err?.error_code ?? null,
        });
        if (err) {
          console.error("[yomi] Plaid Link exit", {
            err,
            status,
            link_session_id: metadata?.link_session_id,
            request_id: metadata?.request_id,
          });
          report({
            kind: "exit",
            errorCode: err.error_code,
            errorType: err.error_type,
            errorMessage: err.error_message,
            displayMessage: err.display_message,
            institution,
            status,
            linkSessionId: metadata?.link_session_id,
            requestId: metadata?.request_id,
          });
          const detail = [err.error_code, err.display_message ?? err.error_message, institution].filter(Boolean).join(" · ");
          const p = getClientDictionary().bank.plaid;
          reject(new Error(fmt(p.failed, { detail: detail ? `${p.detailSep}${detail}` : "" })));
          return;
        }
        if (status) {
          report({ kind: "exit", institution, status, linkSessionId: metadata?.link_session_id, requestId: metadata?.request_id });
          toast.info(fmt(getClientDictionary().bank.plaid.closed, { status }));
        }
        resolve(null);
      },
      onEvent: (eventName, metadata) => {
        if (metadata.link_session_id) lastSessionId = metadata.link_session_id;
        if (metadata.view_name === "CONNECTED" || eventName === "HANDOFF") sawConnected = true;
        if (eventName !== "ERROR") return;
        console.error("[yomi] Plaid Link ERROR event", metadata);
        report({
          kind: "event",
          errorCode: metadata.error_code,
          errorType: metadata.error_type,
          errorMessage: metadata.error_message,
          institution: metadata.institution_name,
          status: metadata.exit_status ?? metadata.view_name,
          linkSessionId: metadata.link_session_id,
          requestId: metadata.request_id,
        });
      },
    });
    handler.open();
  });
}
