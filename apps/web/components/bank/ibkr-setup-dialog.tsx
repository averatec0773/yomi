"use client";

import { CheckCircle2Icon, PlugZapIcon, SaveIcon, Trash2Icon } from "lucide-react";
import type { IbkrSaveInput, IbkrTestResult, SecretsView } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Sheet, TextInput } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { Dialog, DialogClose } from "@/components/ui/dialog";
import { plural } from "@/i18n";
import { useLocale, useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { dayLabel } from "@/lib/month";
import { ConfirmRemove } from "./confirm-remove";
import { Guide, KeyNote, SecretInput, UntestedToggle } from "./secret-form";

/** IBKR pages the steps link to (checked on IBKR_GUIDE_CHECKED_ON). */
const IBKR_LINKS = {
  portal: "https://www.interactivebrokers.com/portal/",
  queryGuide: "https://www.ibkrguides.com/clientportal/performanceandstatements/activityflex.htm",
  tokenGuide: "https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm",
  flexApi: "https://www.interactivebrokers.com/docs/web-api/api-reference/send-request",
};
/** When the IBKR steps were last compared with the pages above (update with the copy). */
const IBKR_GUIDE_CHECKED_ON = "2026-10-01";

type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; result: IbkrTestResult } | { kind: "error"; text: string };

/**
 * Settings > Connections > Interactive Brokers: "Set up" / "Replace token" (md dialog). Guide, Flex query ID
 * (prefilled with the saved one, it is not secret), Flex token and optional expiry date; "Test connection" pulls the
 * query once through the real Flex flow; Save is enabled after a successful test or when "Save without a successful
 * test" is ticked. Fields set by env are read-only. The token never comes back from the server.
 */
export function IbkrSetupDialog({
  open,
  onOpenChange,
  ibkr,
  keyInfo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ibkr: SecretsView["ibkr"];
  keyInfo: SecretsView["key"];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <IbkrSetupSheet ibkr={ibkr} keyInfo={keyInfo} onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function IbkrSetupSheet({ ibkr, keyInfo, onDone }: { ibkr: SecretsView["ibkr"]; keyInfo: SecretsView["key"]; onDone: () => void }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const s = t.secrets;
  const i = s.ibkr;
  const [token, setToken] = useState("");
  const savedQueryId = ibkr.queryId.source === "settings" ? (ibkr.queryId.value ?? "") : "";
  const [queryId, setQueryId] = useState(savedQueryId);
  const [expiresOn, setExpiresOn] = useState(ibkr.expiresOn ?? "");
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [untested, setUntested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const configured = ibkr.token.configured && ibkr.queryId.configured;
  const queryChanged = ibkr.queryId.source !== "env" && queryId.trim() !== "" && queryId.trim() !== savedQueryId;
  const credentialsChanged = token.trim() !== "" || queryChanged;
  const expiryChanged = (expiresOn || null) !== ibkr.expiresOn;
  const haveToken = token.trim() !== "" || ibkr.token.configured;
  const haveQuery = ibkr.queryId.source === "env" ? ibkr.queryId.configured : queryId.trim() !== "";
  const tested = test.kind === "ok";
  const canSave = !busy && keyInfo.state !== "malformed" && (credentialsChanged ? haveToken && haveQuery && (tested || untested) : expiryChanged);
  const fromSettings = ibkr.token.source === "settings" || ibkr.queryId.source === "settings" || ibkr.expiresOn != null;

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (test.kind !== "testing") setTest({ kind: "idle" });
  };

  async function runTest() {
    setTest({ kind: "testing" });
    try {
      const body = { ...(token.trim() ? { token: token.trim() } : {}), ...(queryChanged ? { queryId: queryId.trim() } : {}) };
      const result = await apiFetch<IbkrTestResult>("/api/settings/secrets/ibkr/test", { json: body, silent: true });
      setTest({ kind: "ok", result });
    } catch (e) {
      setTest({ kind: "error", text: errorText(e, t) });
    }
  }

  async function save() {
    const body: IbkrSaveInput = {};
    if (token.trim()) body.token = token.trim();
    if (queryChanged) body.queryId = queryId.trim();
    if (expiryChanged) body.expiresOn = expiresOn || null;
    setBusy(true);
    try {
      await apiFetch("/api/settings/secrets/ibkr", { method: "PUT", json: body });
      toast.success(i.saved);
      router.refresh();
      onDone();
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await apiFetch("/api/settings/secrets/ibkr", { method: "DELETE" });
      toast.success(i.removed);
      setConfirm(false);
      router.refresh();
      onDone();
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <div className="flex flex-col gap-2">
      {credentialsChanged && !tested && <UntestedToggle checked={untested} onChange={setUntested} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {fromSettings && (
          <Button variant="ghost" onClick={() => setConfirm(true)} disabled={busy} className="mr-auto">
            <Trash2Icon aria-hidden />
            {s.remove}
          </Button>
        )}
        <DialogClose asChild>
          <Button variant="ghost">{t.common.cancel}</Button>
        </DialogClose>
        <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
          <SaveIcon aria-hidden />
          {busy ? t.common.saving : t.common.save}
        </Button>
      </div>
    </div>
  );

  return (
    <Sheet title={configured ? i.replaceTitle : i.setupTitle} description={i.description} footer={footer} data-testid="ibkr-setup-dialog">
      <div className="flex flex-col gap-4 pb-5">
        <Guide title={i.guideTitle} steps={i.steps} labels={i.links} hrefs={IBKR_LINKS} testId="ibkr-guide" defaultOpen={!configured} checkedOn={IBKR_GUIDE_CHECKED_ON} />
        <SecretInput
          id="ibkr-query"
          label={i.queryId}
          field={ibkr.queryId}
          envName="IBKR_FLEX_QUERY_ID"
          value={queryId}
          onChange={edit(setQueryId)}
          hint={i.queryIdHint}
          inputProps={{ inputMode: "numeric" }}
          masked={false}
        />
        <SecretInput id="ibkr-token" label={i.token} field={ibkr.token} envName="IBKR_FLEX_TOKEN" value={token} onChange={edit(setToken)} />
        <label className="flex max-w-60 flex-col gap-1">
          <span className="text-meta text-2">{i.expiresOn}</span>
          <TextInput type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className="h-10" data-testid="ibkr-expires-on" />
          <span className="text-meta text-2">{i.expiresOnHint}</span>
        </label>
        <div className="flex flex-col gap-2">
          <Button className="self-start" onClick={() => void runTest()} disabled={test.kind === "testing" || !haveToken || !haveQuery}>
            <PlugZapIcon aria-hidden />
            {test.kind === "testing" ? s.testing : s.test}
          </Button>
          <p role="status" className="text-meta text-2" data-testid="ibkr-test-result">
            {test.kind === "testing" && s.testSlow}
            {test.kind === "ok" && (
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <CheckCircle2Icon className="size-3.5 text-2" aria-hidden />
                {plural(i.testOk, test.result.positions, { date: dayLabel(test.result.statementDate, locale, { year: true }) })}
              </span>
            )}
            {test.kind === "error" && <span className="text-foreground">{test.text}</span>}
          </p>
        </div>
        <KeyNote keyInfo={keyInfo} />
      </div>
      <ConfirmRemove
        open={confirm}
        onOpenChange={setConfirm}
        title={i.removeTitle}
        body={i.removeBody}
        confirmLabel={i.removeConfirm}
        busy={busy}
        onConfirm={() => void remove()}
        testId="ibkr-remove-dialog"
      />
    </Sheet>
  );
}
