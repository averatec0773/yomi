import { userSettings } from "@yomi/db";
import { describe, expect, it } from "vitest";
import { freshDb, user } from "../ledger/test-helpers";
import { getDisplayName, normalizeDisplayName, setDisplayName } from "./profile";
import { writeSetting } from "./store";

describe("display name", () => {
  it("round-trips a trimmed name and removes the row when empty", async () => {
    const db = await freshDb();
    expect(await getDisplayName(db, user)).toBeNull();
    expect(await setDisplayName(db, user, "  Sam ")).toBe("Sam");
    expect((await db.select().from(userSettings)).filter((r) => r.key === "display_name").map((r) => r.value)).toEqual(["Sam"]);
    expect(await setDisplayName(db, user, "   ")).toBeNull();
    expect((await db.select().from(userSettings)).some((r) => r.key === "display_name")).toBe(false);
    expect(await setDisplayName(db, user, null)).toBeNull();
  });

  it("caps the name at 40 characters, also when stored by hand", async () => {
    const db = await freshDb();
    expect(normalizeDisplayName("a".repeat(45))).toBe("a".repeat(40));
    await writeSetting(db, user, "display_name", ` ${"b".repeat(50)} `);
    expect(await getDisplayName(db, user)).toBe("b".repeat(40));
  });
});
