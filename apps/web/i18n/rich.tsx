import { Fragment, type ReactNode } from "react";

/**
 * Like `fmt`, but placeholders may be React nodes: rich("{amount} less than {prev}", { amount: <Money …/>, prev }).
 * Server and client (no hooks).
 */
export function rich(template: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/\{(\w+)\}/g);
  return parts.map((part, i) =>
    i % 2 === 0 ? part : <Fragment key={i}>{part in vars ? vars[part] : `{${part}}`}</Fragment>,
  );
}
