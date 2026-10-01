"use client";

import { ChevronDownIcon, CodeXmlIcon, PlugZapIcon, SaveIcon, Trash2Icon } from "lucide-react";
import type { PlaidKeyField, PlaidSaveInput, PlaidTestResult, SecretsView } from "@yomi/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui-kit/button";
import { Segmented } from "@/components/ui-kit/segmented";
import { fmt } from "@/i18n";
import { useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ConfirmRemove } from "./confirm-remove";
import { Guide, KeyNote, SecretInput, UntestedToggle } from "./secret-form";

export const DEVELOPER_KEYS_ID = "developer-keys";

/** Plaid pages the steps link to (checked on GUIDES_CHECKED_ON). */
const PLAID_LINKS = {
  dashboard: "https://dashboard.plaid.com/",
  keys: "https://dashboard.plaid.com/developers/keys",
  trial: "https://dashboard.plaid.com/trial-plan",
  products: "https://dashboard.plaid.com/settings/team/products",
  oauth: "https://plaid.com/docs/link/oauth/",
};

type Env = "sandbox" | "production";
type TestState = { kind: "idle" } | { kind: "testing" } | { kind: "ok" } | { kind: "error"; text: string };
const ENV_NAMES: Record<PlaidKeyField, string> = { clientId: "PLAID_CLIENT_ID", sandbox: "PLAID_SECRET_SANDBOX", production: "PLAID_SECRET_PRODUCTION" };

/**
 * Settings > Connections > "Developer keys" (instance level, collapsed by default; opens itself when the URL hash is
 * #developer-keys): Plaid client ID, Sandbox and Production secrets, the default environment for new connections.
 * "Test keys" per environment calls Plaid's /institutions/get; Save needs a passing test for every environment
 * whose keys changed, or "Save without a successful test". Values from env are read-only. The client ID is not
 * secret and shows its saved value; the secrets are never shown back.
 */
export function DeveloperKeys({ plaid, keyInfo }: { plaid: SecretsView["plaid"]; keyInfo: SecretsView["key"] }) {
  const t = useT();
  const p = t.secrets.plaid;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const sync = () => {
      if (window.location.hash === `#${DEVELOPER_KEYS_ID}`) setOpen(true);
    };
    sync();
    // Again after the router's own mount effects, which can briefly put the URL back without its hash.
    const timer = setTimeout(sync, 50);
    window.addEventListener("hashchange", sync);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  return (
    <section id={DEVELOPER_KEYS_ID} data-anchor className="scroll-mt-18 rounded-xl border border-border bg-surface" data-testid="developer-keys">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${DEVELOPER_KEYS_ID}-body`}
          onClick={() => setOpen((o) => !o)}
          className="hit relative flex min-h-14 w-full items-center gap-2.5 px-4 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:px-5"
        >
          <CodeXmlIcon className="size-[18px] shrink-0 text-2" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-title font-semibold">{p.title}</span>
            <span className="text-meta text-2">{p.hint}</span>
          </span>
          <ChevronDownIcon className={cn("size-4 shrink-0 text-2 transition-transform duration-[120ms]", open && "rotate-180")} aria-hidden />
        </button>
      </h3>
      {open && (
        <div id={`${DEVELOPER_KEYS_ID}-body`} className="border-t border-line-soft px-4 py-4 md:px-5">
          <DeveloperKeysForm plaid={plaid} keyInfo={keyInfo} />
        </div>
      )}
    </section>
  );
}

function DeveloperKeysForm({ plaid, keyInfo }: { plaid: SecretsView["plaid"]; keyInfo: SecretsView["key"] }) {
  const t = useT();
  const router = useRouter();
  const s = t.secrets;
  const p = s.plaid;
  const savedClientId = plaid.clientId.source === "settings" ? (plaid.clientId.value ?? "") : "";
  const [values, setValues] = useState<Record<PlaidKeyField, string>>({ clientId: savedClientId, sandbox: "", production: "" });
  const [defaultEnv, setDefaultEnv] = useState<Env | null>(plaid.defaultEnvironment.value);
  const [tests, setTests] = useState<Record<Env, TestState>>({ sandbox: { kind: "idle" }, production: { kind: "idle" } });
  const [untested, setUntested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<PlaidKeyField | null>(null);

  // The client ID is prefilled with its saved value, so it counts as typed only when it differs.
  const typed = (f: PlaidKeyField) =>
    f === "clientId" ? plaid.clientId.source !== "env" && values.clientId.trim() !== "" && values.clientId.trim() !== savedClientId : values[f].trim() !== "";
  const have = (f: PlaidKeyField) =>
    f === "clientId" ? (plaid.clientId.source === "env" ? plaid.clientId.configured : values.clientId.trim() !== "") : typed(f) || plaid[f].configured;
  // An environment needs a test when its secret or the client id changed and it will have a secret after saving.
  const needsTest = (e: Env) => (typed(e) || typed("clientId")) && have(e) && have("clientId");
  const untestedEnvs = (["sandbox", "production"] as const).filter((e) => needsTest(e) && tests[e].kind !== "ok");
  const keysChanged = typed("clientId") || typed("sandbox") || typed("production");
  const envChanged = plaid.defaultEnvironment.source !== "env" && defaultEnv !== plaid.defaultEnvironment.value;
  const canSave = !busy && keyInfo.state !== "malformed" && (keysChanged || envChanged) && (untestedEnvs.length === 0 || untested);

  function set(f: PlaidKeyField, v: string) {
    setValues((x) => ({ ...x, [f]: v }));
    setTests((x) => (f === "clientId" ? { sandbox: { kind: "idle" }, production: { kind: "idle" } } : { ...x, [f]: { kind: "idle" } }));
  }

  async function test(e: Env) {
    setTests((x) => ({ ...x, [e]: { kind: "testing" } }));
    try {
      const body = { environment: e, ...(typed("clientId") ? { clientId: values.clientId.trim() } : {}), ...(typed(e) ? { secret: values[e].trim() } : {}) };
      const r = await apiFetch<PlaidTestResult>("/api/settings/secrets/plaid/test", { json: body, silent: true });
      setTests((x) => ({ ...x, [e]: r.ok ? { kind: "ok" } : { kind: "error", text: fmt(p.testFailed, { code: r.code }) } }));
    } catch (err) {
      setTests((x) => ({ ...x, [e]: { kind: "error", text: errorText(err, t) } }));
    }
  }

  async function save() {
    const body: PlaidSaveInput = {};
    for (const f of ["clientId", "sandbox", "production"] as const) if (typed(f)) body[f] = values[f].trim();
    if (envChanged) body.defaultEnvironment = defaultEnv;
    setBusy(true);
    try {
      await apiFetch("/api/settings/secrets/plaid", { method: "PUT", json: body });
      toast.success(p.saved);
      setValues({ clientId: body.clientId ?? values.clientId.trim(), sandbox: "", production: "" });
      setTests({ sandbox: { kind: "idle" }, production: { kind: "idle" } });
      setUntested(false);
      router.refresh();
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(false);
    }
  }

  async function remove(f: PlaidKeyField) {
    setBusy(true);
    try {
      await apiFetch(`/api/settings/secrets/plaid/${f}`, { method: "DELETE" });
      toast.success(p.removed);
      setRemoving(null);
      if (f === "clientId") setValues((x) => ({ ...x, clientId: "" }));
      router.refresh();
    } catch {
      // toasted by apiFetch
    } finally {
      setBusy(false);
    }
  }

  const removeButton = (f: PlaidKeyField) =>
    plaid[f].source === "settings" && (
      <Button variant="ghost" size="sm" onClick={() => setRemoving(f)} disabled={busy} aria-label={`${s.remove} ${p[f]}`}>
        <Trash2Icon aria-hidden />
        <span className="max-md:sr-only">{s.remove}</span>
      </Button>
    );

  const secretRow = (e: Env) => {
    const state = tests[e];
    return (
      <div className="flex flex-col gap-1">
        <SecretInput
          id={`plaid-${e}`}
          label={p[e]}
          field={plaid[e]}
          envName={ENV_NAMES[e]}
          value={values[e]}
          onChange={(v) => set(e, v)}
          aside={
            <>
              <Button size="md" onClick={() => void test(e)} disabled={state.kind === "testing" || !have(e) || !have("clientId")}>
                <PlugZapIcon aria-hidden />
                {state.kind === "testing" ? s.testing : p.testKeys}
              </Button>
              {removeButton(e)}
            </>
          }
        />
        <p role="status" className="min-h-0 text-meta" data-testid={`plaid-test-${e}`}>
          {state.kind === "ok" && <span className="text-foreground">{p.testOk}</span>}
          {state.kind === "error" && <span className="text-foreground">{state.text}</span>}
        </p>
      </div>
    );
  };

  const envOptions = (["production", "sandbox"] as const).map((e) => ({ value: e, label: t.bank.envs[e] ?? e }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-2">{p.description}</p>
      <Guide title={p.guideTitle} steps={p.steps} labels={p.links} hrefs={PLAID_LINKS} testId="plaid-guide" defaultOpen={!plaid.clientId.configured} />
      <SecretInput id="plaid-client-id" label={p.clientId} field={plaid.clientId} envName={ENV_NAMES.clientId} value={values.clientId} onChange={(v) => set("clientId", v)} aside={removeButton("clientId")} masked={false} />
      {secretRow("sandbox")}
      {secretRow("production")}
      <div className="flex flex-col gap-1" data-testid="plaid-default-env">
        <span className="text-meta text-2">{p.defaultEnvironment}</span>
        {plaid.defaultEnvironment.source === "env" ? (
          <>
            <p className="text-body">
              {t.bank.envs[plaid.defaultEnvironment.value ?? ""] ?? plaid.defaultEnvironment.value} <span className="text-meta text-2">· {s.envSet}</span>
            </p>
            <span className="text-meta text-2">{fmt(s.envHint, { name: "PLAID_ENV" })}</span>
          </>
        ) : (
          <Segmented<Env | null> value={defaultEnv} options={envOptions} onChange={setDefaultEnv} label={p.defaultEnvironment} />
        )}
      </div>
      <KeyNote keyInfo={keyInfo} />
      {untestedEnvs.length > 0 && keysChanged && <UntestedToggle checked={untested} onChange={setUntested} />}
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
          <SaveIcon aria-hidden />
          {busy ? t.common.saving : t.common.save}
        </Button>
      </div>
      <ConfirmRemove
        open={removing != null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={fmt(p.removeTitle, { field: removing ? p[removing].toLowerCase() : "" })}
        body={p.removeBody}
        confirmLabel={p.removeConfirm}
        busy={busy}
        onConfirm={() => removing && void remove(removing)}
        testId="plaid-remove-dialog"
      />
    </div>
  );
}
