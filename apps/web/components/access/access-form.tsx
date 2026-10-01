"use client";

import { ArrowRightIcon, LogOutIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Field, TextInput } from "@/components/split/ui";
import { Button } from "@/components/ui-kit/button";
import { useT } from "@/i18n/client";
import { errorText } from "@/i18n/errors";
import { apiFetch, ApiRequestError } from "@/lib/api";

/** /access: one token field; on success the cookie is set by POST /api/access and the browser loads `next` (a same-origin path). */
export function AccessForm({ next }: { next: string }) {
  const t = useT();
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/access", { json: { token }, silent: true });
      // A full load, so every server component renders again with the cookie.
      window.location.assign(next);
    } catch (err) {
      setError(err instanceof ApiRequestError ? errorText(err, t) : t.errors.unknown);
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="access-form">
      <Field label={t.access.label}>
        <TextInput
          type="password"
          name="token"
          autoComplete="current-password"
          autoFocus
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </Field>
      {error && (
        <p role="alert" className="text-meta text-foreground">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" disabled={pending || token.trim() === ""}>
          <ArrowRightIcon aria-hidden />
          {t.access.submit}
        </Button>
      </div>
    </form>
  );
}

/** Settings: forget the access cookie on this browser, then land on /access. */
export function SignOutButton() {
  const t = useT();
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      await apiFetch("/api/access", { method: "DELETE" });
      window.location.assign("/access?next=%2Fsettings%3Ftab%3Dsecurity");
    } catch {
      setPending(false);
    }
  }

  return (
    <Button onClick={run} disabled={pending} size="sm" className="self-start">
      <LogOutIcon aria-hidden />
      {t.settings.signOut}
    </Button>
  );
}
