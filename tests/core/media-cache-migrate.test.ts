import { describe, it, expect } from "bun:test";
import { planMigration } from "../../scripts/migrate-media-cache-chat-key";

describe("planMigration (F45-C)", () => {
  it("gives a destination to a file whose id belongs to exactly one chat", () => {
    const plan = planMigration({
      files: [{ platform: "telegram", messageId: "19244", ext: "jpg" }],
      owners: new Map([["telegram:19244", ["-1001782953277"]]]),
    });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]!.to).toContain("/telegram/msg/-1001782953277/19244.jpg");
    expect(plan.moves[0]!.from).toContain("/telegram/msg/19244.jpg");
    expect(plan.orphans).toHaveLength(0);
  });

  it("leaves an ambiguous id alone and reports it", () => {
    const plan = planMigration({
      files: [{ platform: "telegram", messageId: "19245", ext: "jpg" }],
      owners: new Map([["telegram:19245", ["-1001782953277", "8546705305"]]]),
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.orphans).toEqual([
      { platform: "telegram", messageId: "19245", ext: "jpg", reason: "ambiguous" },
    ]);
  });

  it("leaves an id core no longer stores alone and reports it", () => {
    const plan = planMigration({
      files: [{ platform: "telegram", messageId: "1", ext: "jpg" }],
      owners: new Map(),
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.orphans[0]!.reason).toBe("unknown");
  });

  it("encodes a chat id into one path segment, so it cannot leave the cache root", () => {
    const plan = planMigration({
      root: "/c",
      files: [{ platform: "telegram", messageId: "7", ext: "jpg" }],
      owners: new Map([["telegram:7", ["../../etc"]]]),
    });
    expect(plan.moves[0]!.to.startsWith("/c/telegram/msg/")).toBe(true);
    expect(plan.moves[0]!.to.split("/").includes("..")).toBe(false);
  });

  // Same rule core adopted in Step 1.1: when an id hits several rows but only one of them
  // carries media, that row is the owner. Two policies for one problem is how F45 happened.
  it("moves a file when exactly one of the colliding rows carries media", () => {
    const plan = planMigration({
      files: [{ platform: "telegram", messageId: "4578", ext: "jpg" }],
      owners: new Map([["telegram:4578", ["8529682445", "-1004473403544"]]]),
      mediaOwners: new Map([["telegram:4578", ["8529682445"]]]),
    });
    expect(plan.orphans).toHaveLength(0);
    expect(plan.moves[0]!.to).toContain("/telegram/msg/8529682445/4578.jpg");
  });

  it("still refuses when several of the colliding rows carry media", () => {
    const plan = planMigration({
      files: [{ platform: "telegram", messageId: "19245", ext: "jpg" }],
      owners: new Map([["telegram:19245", ["-100A", "-100B"]]]),
      mediaOwners: new Map([["telegram:19245", ["-100A", "-100B"]]]),
    });
    expect(plan.moves).toHaveLength(0);
    expect(plan.orphans[0]!.reason).toBe("ambiguous");
  });

  it("applies the same rule to negative keys", () => {
    const plan = planMigration({
      files: [],
      owners: new Map([["telegram:4578", ["8529682445", "-1004473403544"]]]),
      mediaOwners: new Map([["telegram:4578", ["8529682445"]]]),
      negativeKeys: ["telegram/msg/4578"],
    });
    expect(plan.negativeRenames).toEqual([
      { from: "telegram/msg/4578", to: "telegram/msg/8529682445/4578" },
    ]);
    expect(plan.negativeOrphans).toHaveLength(0);
  });

  it("rewrites the negative keys the same way it rewrites the files", () => {
    const plan = planMigration({
      files: [],
      owners: new Map([["telegram:19244", ["-100A"]], ["telegram:19245", ["-100A", "-100B"]]]),
      negativeKeys: [
        "telegram/msg/19244",              // unique owner  → rewritten
        "telegram/msg/19245",              // ambiguous     → left alone
        "telegram/msg/99999",              // unknown       → left alone
        "line/sticker/7432559",            // content-addressed → untouched by design
        "telegram/msg/-100A/19244",        // already migrated → untouched
      ],
    });
    expect(plan.negativeRenames).toEqual([
      { from: "telegram/msg/19244", to: "telegram/msg/-100A/19244" },
    ]);
    expect(plan.negativeOrphans).toEqual([
      { key: "telegram/msg/19245", reason: "ambiguous" },
      { key: "telegram/msg/99999", reason: "unknown" },
    ]);
  });
});
