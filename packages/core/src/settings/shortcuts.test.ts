import { userSettings } from "@yomi/db";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { writeSetting } from "./store";
import { getShortcutOverrides, setShortcutOverrides } from "./shortcuts";

describe("shortcut overrides", () => {
  it("round-trips one JSON value and removes the row when empty", async () => {
    const db = await freshDb();
    expect(await getShortcutOverrides(db, user)).toEqual({});
    expect(await setShortcutOverrides(db, user, { leader: ";", listNote: "" })).toEqual({ leader: ";", listNote: "" });
    expect((await db.select().from(userSettings)).filter((r) => r.key === "shortcuts").map((r) => r.value)).toEqual(['{"leader":";","listNote":""}']);
    expect(await setShortcutOverrides(db, user, {})).toEqual({});
    expect((await db.select().from(userSettings)).some((r) => r.key === "shortcuts")).toBe(false);
  });

  it("reads a damaged value as no overrides and drops non-string entries", async () => {
    const db = await freshDb();
    await writeSetting(db, user, "shortcuts", "{not json");
    expect(await getShortcutOverrides(db, user)).toEqual({});
    await writeSetting(db, user, "shortcuts", "[1,2]");
    expect(await getShortcutOverrides(db, user)).toEqual({});
    await writeSetting(db, user, "shortcuts", '{"leader":";","goStats":5}');
    expect(await getShortcutOverrides(db, user)).toEqual({ leader: ";" });
  });
});
