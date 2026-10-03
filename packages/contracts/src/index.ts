import { z } from "zod";

export * from "./common";
export * from "./import";
export * from "./split";
export * from "./capture";
export * from "./quick";
export * from "./ledger";
export * from "./month";
export * from "./stats";
export * from "./analysis";
export * from "./maintenance";
export * from "./bank";
export * from "./invest";
export * from "./assets";
export * from "./shortcuts";

export const Health = z.object({ ok: z.literal(true) });
export type Health = z.infer<typeof Health>;
export * from "./payment";
export * from "./tools";
export * from "./secrets";
