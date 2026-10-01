/** Dictionary helpers. Pure, server and client. */

/** A count-dependent string: `one` for exactly 1, `other` for everything else. `{count}` is filled in. */
export interface Plural {
  one: string;
  other: string;
}

type Vars = Record<string, string | number>;

/** Fills `{name}` placeholders: fmt("Split {count} with {name}", { count: 2, name: "Li" }). Unknown names stay as is. */
export function fmt(template: string, vars: Vars = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Picks the plural form for `count` and fills `{count}` plus any other vars. */
export function plural(forms: Plural, count: number, vars: Vars = {}): string {
  return fmt(count === 1 ? forms.one : forms.other, { count, ...vars });
}
