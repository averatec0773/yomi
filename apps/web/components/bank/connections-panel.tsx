import { ChartCandlestickIcon, LandmarkIcon } from "lucide-react";
import { getCurrentUser, ibkrSecretsView, listConnections, plaidSecretsView, resolvePlaidConfig, resolvePlaidProvider, secretKeyInfo, secretsHealth, settingsStatus } from "@yomi/core";
import type { BankConnectionView, SecretsView } from "@yomi/contracts";
import { EmptyState } from "@/components/ui-kit/empty-state";
import { ListCard } from "@/components/ui-kit/list-card";
import { errorText } from "@/i18n/errors";
import { getI18n } from "@/i18n/server";
import { getDb } from "@/lib/db";
import { ConnectionRow } from "./bank-connections";
import { ConnectActions, PlaidSetup } from "./connect-actions";
import { DeveloperKeys } from "./developer-keys";
import { ResumePendingExchange } from "./connect-bank-button";
import { IbkrRow } from "./ibkr-row";

/**
 * Settings > Connections: connect actions (or the Plaid setup line), then every connected source in
 * two cards, Banks (Plaid bank logins) and Brokerages (Interactive Brokers through Flex, Plaid
 * brokerage logins), one privacy line, then the collapsed "Developer keys" group (Plaid keys for a self-hosted
 * install). Credentials resolve env first, then Settings; values never reach the page, only set / last 4 / source.
 */
export async function ConnectionsPanel() {
  const { t } = await getI18n();
  const c = t.connections;
  const db = await getDb();
  const user = getCurrentUser();
  // Resolved per render (env, then Settings), so keys saved a moment ago show at once.
  const cfg = await resolvePlaidConfig(db);
  const connections = (await listConnections(db, user, await resolvePlaidProvider(db))) as BankConnectionView[];
  const secrets = await secretsHealth(db);
  const { ibkr } = await settingsStatus(db, user);
  const k = secretKeyInfo();
  const keyInfo: SecretsView["key"] = { source: k.source, state: k.state, file: k.file };
  const ibkrSecrets = await ibkrSecretsView(db, user);
  const plaidSecrets = await plaidSecretsView(db);
  const environments = cfg.configured ? cfg.environments : null;
  const banks = connections.filter((x) => x.kind === "bank");
  const brokerages = connections.filter((x) => x.kind === "brokerage");

  return (
    <div className="flex flex-col gap-5" data-testid="settings-connections">
      {cfg.configured ? (
        <>
          <ResumePendingExchange />
          <ConnectActions environments={cfg.environments} defaultEnvironment={cfg.defaultEnvironment} />
        </>
      ) : (
        <PlaidSetup />
      )}
      {secrets.error && (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-body text-destructive" data-testid="bank-secret-error">
          {errorText({ code: secrets.errorCode, message: secrets.error }, t)}
        </p>
      )}

      <ListCard title={c.banks} heading="h3" icon={LandmarkIcon} data-testid="connections-banks">
        {banks.length === 0 ? (
          <EmptyState variant="inline" icon={LandmarkIcon}>
            {c.noBanks}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft">
            {banks.map((x) => (
              <ConnectionRow key={x.id} conn={x} environments={environments} />
            ))}
          </ul>
        )}
      </ListCard>

      <ListCard title={c.brokerages} heading="h3" icon={ChartCandlestickIcon} data-testid="connections-brokerages">
        <ul className="divide-y divide-line-soft">
          <IbkrRow status={ibkr} secrets={ibkrSecrets} keyInfo={keyInfo} />
          {brokerages.map((x) => (
            <ConnectionRow key={x.id} conn={x} environments={environments} />
          ))}
        </ul>
      </ListCard>

      <div className="flex flex-col gap-1 text-meta">
        <p className="text-2" data-testid="connections-privacy">
          {secrets.key === "present" && secrets.plaintext === 0 ? c.privacy : c.privacyPlain}
        </p>
        {secrets.plaintext > 0 && !secrets.error && (
          <p className="text-3" data-testid="bank-secret-notice">
            {secrets.key === "present" ? t.bank.plaintextNoticeKey : t.bank.plaintextNotice}
          </p>
        )}
      </div>

      <DeveloperKeys plaid={plaidSecrets} keyInfo={keyInfo} />
    </div>
  );
}
