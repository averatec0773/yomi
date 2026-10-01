import { userSettings } from "@yomi/db";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { writeSetting } from "./store";
import { getTheme, setTheme } from "./theme";

describe("theme setting", () => {
  it("defaults to system, round-trips light and dark, and removes the row for system", async () => {
    const db = await freshDb();
    const stored = async () => (await db.select().from(userSettings)).filter((r) => r.key === "theme").map((r) => r.value);
    expect(await getTheme(db, user)).toBe("system");
    expect(await setTheme(db, user, "light")).toBe("light");
    expect(await stored()).toEqual(["light"]);
    expect(await setTheme(db, user, "dark")).toBe("dark");
    expect(await getTheme(db, user)).toBe("dark");
    expect(await stored()).toEqual(["dark"]);
    expect(await setTheme(db, user, "system")).toBe("system");
    expect(await stored()).toEqual([]);
  });

  it("reads an unknown stored value as system", async () => {
    const db = await freshDb();
    await writeSetting(db, user, "theme", "sepia");
    expect(await getTheme(db, user)).toBe("system");
  });
});
