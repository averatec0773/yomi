import { describe, expect, it } from "vitest";
import { keywordCategoryName, sourceCategoryName } from "./categorize";

describe("keywordCategoryName", () => {
  it.each([
    ["腾讯天游 游戏充值", "娱乐"],
    ["Nintendo", "娱乐"],
    ["BLIZZARD ENT", "娱乐"],
    ["网易云音乐 会员", "订阅"],
    ["网易游戏", "娱乐"],
    ["BILIBILI 大会员", "订阅"],
    ["Apple Music", "订阅"],
    ["中国联通 话费充值", "居住"],
    ["中国移动", "居住"],
    ["某商户 移动支付", null],
    ["美团外卖", "餐饮"],
    ["BUSY BEE BOBA", "餐饮"],
    ["UBER *EATS", "餐饮"],
    ["UBER *TRIP", "交通"],
    ["DoorDash Chipotle", "餐饮"],
    ["得物", "购物"],
    ["京东商城", "购物"],
    ["Target", "购物"],
    ["H-E-B #123", "买菜"],
    ["99 Ranch Market", "买菜"],
    ["Trader Joe's", "买菜"],
    ["Costco Whse", "买菜"],
    ["JetBlue Airways", "旅行"],
    ["United Airlines", "旅行"],
    ["Delta Air Lines", "旅行"],
    ["Airbnb", "旅行"],
    ["Hilton Garden Inn", "旅行"],
    ["State University Bursar", "教育"],
    ["Coursera", "教育"],
    ["Walgreens #1234", "医疗"],
    ["CVS Pharmacy", "医疗"],
    ["Pho Saigon", "餐饮"],
    ["Sunrise Kitchen", "餐饮"],
    ["Boba Tea House", "餐饮"],
    ["Golden Dumpling", "餐饮"],
    ["Hot Pot Paradise", "餐饮"],
    ["Popeyes Chicken", "餐饮"],
    ["某某小吃", "餐饮"],
    ["奶茶店", "餐饮"],
    ["CASHBACK REBATE", "其他收入"],
    ["Steamboat Supplies", "娱乐"],
    ["ANTHROPIC", "订阅"],
    ["Claude.ai Subscription", "订阅"],
    ["CLAUDE AI SUBSCRIPTION ANTHROPIC.COM CA", "订阅"],
    ["OPENAI *CHATGPT SUBSCR", "订阅"],
    ["ChatGPT Plus", "订阅"],
    ["Precursor Coffee", "餐饮"],
    ["Somewhere Odd", null],
  ])("%s → %s", (input, expected) => {
    expect(keywordCategoryName(input)).toBe(expected);
  });
});

describe("sourceCategoryName", () => {
  it("nets returned 红包 and transfers against 人情; other refunds inherit (null)", () => {
    expect(sourceCategoryName({ source: "wechat", sourceCategory: "转账-退款" })).toBe("人情");
    expect(sourceCategoryName({ source: "wechat", sourceCategory: "微信红包-退款" })).toBe("人情");
    expect(sourceCategoryName({ source: "wechat", sourceCategory: "商户消费-退款" })).toBeNull();
  });
});
