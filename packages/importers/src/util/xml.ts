// Minimal XML reader for IBKR Flex output: elements, attributes, text, comments, CDATA and the five
// predefined entities plus numeric references. No DTDs, no external or custom entities (a DOCTYPE is
// rejected), so there is no entity-expansion surface. Flex statements are flat, attribute-only XML.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text content directly inside this element, entities decoded, trimmed. */
  text: string;
}

export class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const v = ENTITIES[ref];
    if (v === undefined) throw new XmlParseError(`unknown entity ${whole}`);
    return v;
  });
}

const NAME = /[A-Za-z_:][\w.:-]*/y;
const ATTR = /\s+([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/y;

export function parseXml(input: string): XmlElement {
  const src = input.replace(/^\uFEFF/, "");
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  const texts: string[][] = [[]];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      texts.at(-1)!.push(src.slice(i));
      break;
    }
    if (lt > i) texts.at(-1)!.push(src.slice(i, lt));
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt);
      if (end === -1) throw new XmlParseError("unterminated processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      if (end === -1) throw new XmlParseError("unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt);
      if (end === -1) throw new XmlParseError("unterminated CDATA");
      texts.at(-1)!.push(`\u0000${src.slice(lt + 9, end)}`);
      i = end + 3;
    } else if (src.startsWith("<!", lt)) {
      throw new XmlParseError("DOCTYPE and declarations are not supported");
    } else if (src.startsWith("</", lt)) {
      NAME.lastIndex = lt + 2;
      const m = NAME.exec(src);
      const top = stack.at(-1)!;
      if (!m || m[0] !== top.name) throw new XmlParseError(`mismatched closing tag at ${lt}`);
      const end = src.indexOf(">", NAME.lastIndex);
      if (end === -1 || src.slice(NAME.lastIndex, end).trim() !== "") throw new XmlParseError(`bad closing tag at ${lt}`);
      top.text = joinText(texts.pop()!);
      stack.pop();
      i = end + 1;
    } else {
      NAME.lastIndex = lt + 1;
      const m = NAME.exec(src);
      if (!m) throw new XmlParseError(`bad tag at ${lt}`);
      const el: XmlElement = { name: m[0], attrs: {}, children: [], text: "" };
      let p = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = p;
        const a = ATTR.exec(src);
        if (!a) break;
        el.attrs[a[1]!] = decode(a[3] ?? a[4] ?? "");
        p = ATTR.lastIndex;
      }
      while (/\s/.test(src[p] ?? "")) p++;
      stack.at(-1)!.children.push(el);
      if (src.startsWith("/>", p)) {
        i = p + 2;
      } else if (src[p] === ">") {
        stack.push(el);
        texts.push([]);
        i = p + 1;
      } else {
        throw new XmlParseError(`bad tag <${el.name}> at ${lt}`);
      }
    }
  }
  if (stack.length !== 1) throw new XmlParseError(`unclosed element <${stack.at(-1)!.name}>`);
  const top = root.children.filter((c) => c.name);
  if (top.length !== 1) throw new XmlParseError("expected exactly one root element");
  return top[0]!;
}

function joinText(parts: string[]): string {
  return parts
    .map((p) => (p.startsWith("\u0000") ? p.slice(1) : decode(p)))
    .join("")
    .trim();
}

/** Direct children named `name`. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** First direct child named `name` (case-insensitive when `loose`). */
export function child(el: XmlElement, name: string, loose = false): XmlElement | undefined {
  const n = loose ? name.toLowerCase() : name;
  return el.children.find((c) => (loose ? c.name.toLowerCase() : c.name) === n);
}
