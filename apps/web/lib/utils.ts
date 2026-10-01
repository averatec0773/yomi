import { createCn } from "cn/config"

/** Class merge that knows the yomi type scale, so `text-meta` (size) and `text-2` (color) do not collide. */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["hint", "meta", "body", "title", "total", "page", "display", "hero"] }],
      "text-color": [{ text: ["2", "3", "primary-soft-foreground"] }],
    },
  },
})
