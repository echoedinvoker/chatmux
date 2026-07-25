import { describe, it, expect, beforeEach } from "bun:test";
import {
  fetchContactsBatched,
  fetchChats,
  ContactCache,
  handleGetContacts,
  handleGetChats,
  type ContactClient,
  type CachedContact,
  type CachedChat,
} from "../../../src/adapters/line/contacts.js";

function createMockClient(overrides?: Partial<ContactClient>): ContactClient {
  return {
    async getUserFriendIds() {
      return [];
    },
    async getContactsV3(mids) {
      return mids.map((mid) => ({ mid, displayName: `User ${mid}` }));
    },
    async getAllChatMids() {
      return { memberChatMids: [], invitedChatMids: [] };
    },
    async getChats(chatMids) {
      return chatMids.map((mid) => ({ chatMid: mid, chatName: `Chat ${mid}` }));
    },
    async getMessageBoxes() {
      return [];
    },
    myMid: "u_self",
    ...overrides,
  };
}

function generateMids(count: number, prefix = "u_"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
}

describe("fetchContactsBatched", () => {
  it("returns all contacts for small list (< 100)", async () => {
    const mids = generateMids(5);
    const client = createMockClient({
      async getUserFriendIds() { return mids; },
    });
    const contacts = await fetchContactsBatched(client);
    expect(contacts).toHaveLength(5);
    expect(contacts[0]!.mid).toBe("u_0000");
  });

  it("batches 400+ contacts into chunks of 100", async () => {
    const mids = generateMids(420);
    const batchSizes: number[] = [];
    const client = createMockClient({
      async getUserFriendIds() { return mids; },
      async getContactsV3(requestMids) {
        batchSizes.push(requestMids.length);
        return requestMids.map((mid) => ({ mid, displayName: `User ${mid}` }));
      },
    });
    const contacts = await fetchContactsBatched(client);
    expect(contacts).toHaveLength(420);
    expect(batchSizes).toEqual([100, 100, 100, 100, 20]);
  });

  it("returns empty array for no friends", async () => {
    const client = createMockClient({
      async getUserFriendIds() { return []; },
    });
    const contacts = await fetchContactsBatched(client);
    expect(contacts).toHaveLength(0);
  });

  it("handles exactly 100 contacts (single batch)", async () => {
    const mids = generateMids(100);
    let batchCount = 0;
    const client = createMockClient({
      async getUserFriendIds() { return mids; },
      async getContactsV3(requestMids) {
        batchCount++;
        return requestMids.map((mid) => ({ mid, displayName: `User ${mid}` }));
      },
    });
    const contacts = await fetchContactsBatched(client);
    expect(contacts).toHaveLength(100);
    expect(batchCount).toBe(1);
  });
});

describe("fetchChats", () => {
  it("returns chat list from getAllChatMids + getChats", async () => {
    const client = createMockClient({
      async getAllChatMids() {
        return { memberChatMids: ["c_001", "c_002"], invitedChatMids: [] };
      },
      async getChats(chatMids) {
        return chatMids.map((mid) => ({ chatMid: mid, chatName: `Group ${mid}` }));
      },
    });
    const chats = await fetchChats(client);
    expect(chats).toHaveLength(2);
    expect(chats[0]!.chatMid).toBe("c_001");
  });

  it("returns empty for no chats", async () => {
    const client = createMockClient({
      async getAllChatMids() {
        return { memberChatMids: [], invitedChatMids: [] };
      },
    });
    const chats = await fetchChats(client);
    expect(chats).toHaveLength(0);
  });
});

describe("handleGetContacts", () => {
  it("returns contacts in adapter protocol format", async () => {
    const client = createMockClient({
      async getUserFriendIds() { return ["u_001", "u_002"]; },
      async getContactsV3(mids) {
        return mids.map((mid) => ({ mid, displayName: `User ${mid}` }));
      },
    });

    const result = await handleGetContacts(client);

    expect(result.contacts).toHaveLength(2);
    expect(result.contacts[0].platform_id).toBe("u_001");
    expect(result.contacts[0].display_name).toBe("User u_001");
    expect(result.contacts[1].platform_id).toBe("u_002");
  });
});

describe("handleGetChats", () => {
  it("returns chats in adapter protocol format", async () => {
    const client = createMockClient({
      async getAllChatMids() {
        return { memberChatMids: ["c_001"], invitedChatMids: [] };
      },
      async getChats(chatMids) {
        return [{ chatMid: "c_001", chatName: "工作群組" }];
      },
    });

    const result = await handleGetChats(client);

    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].platform_id).toBe("c_001");
    expect(result.chats[0].type).toBe("group");
    expect(result.chats[0].name).toBe("工作群組");
  });

  it("carries last_message_at from message boxes (protocol v0.3)", async () => {
    const client = createMockClient({
      async getAllChatMids() {
        return { memberChatMids: ["c_001"], invitedChatMids: [] };
      },
      async getChats() {
        return [{ chatMid: "c_001", chatName: "工作群組" }];
      },
      async getMessageBoxes() {
        return [
          { id: "c_001", lastDeliveredTime: 1700000000000 },
          { id: "u_001", lastDeliveredTime: 1700000005000 },
        ];
      },
    });

    const result = await handleGetChats(client);

    const group = result.chats.find((c) => c.platform_id === "c_001");
    const dm = result.chats.find((c) => c.platform_id === "u_001");
    expect(group?.last_message_at).toBe(1700000000000);
    expect(dm?.last_message_at).toBe(1700000005000);
  });

  it("leaves last_message_at null when no message box covers the chat", async () => {
    const client = createMockClient({
      async getAllChatMids() {
        return { memberChatMids: ["c_002"], invitedChatMids: [] };
      },
      async getChats() {
        return [{ chatMid: "c_002", chatName: "冷群組" }];
      },
      async getMessageBoxes() {
        return [];
      },
    });

    const result = await handleGetChats(client);

    expect(result.chats[0].last_message_at).toBeNull();
  });
});

describe("enrichSenderName", () => {
  it("resolves unknown sender via getContactsV3 and caches result", async () => {
    const cache = new ContactCache(
      [{ mid: "u_001", displayName: "Alice" }],
      [],
    );
    const client = createMockClient({
      async getContactsV3(mids) {
        return [{ mid: "u_002", displayName: "Bob" }];
      },
    });

    const { enrichSenderName } = await import("../../../src/adapters/line/contacts.js");
    const name = await enrichSenderName("u_002", cache, client);

    expect(name).toBe("Bob");
    expect(cache.getContact("u_002")?.displayName).toBe("Bob");
  });
});

describe("handleGetChats - DM support", () => {
  it("returns DM chats with type direct and correct name", async () => {
    const contactsMap = new Map([["u_001", "Alice"]]);
    const client = createMockClient({
      async getAllChatMids() {
        return { memberChatMids: ["c_001"], invitedChatMids: [] };
      },
      async getChats(chatMids) {
        return [{ chatMid: "c_001", chatName: "Group Chat" }];
      },
      async getMessageBoxes() {
        return [
          { id: "u_001", lastDeliveredTime: 1000 },
          { id: "c_001", lastDeliveredTime: 2000 },
        ];
      },
    });

    const result = await handleGetChats(client, contactsMap);

    expect(result.chats).toHaveLength(2);
    const dm = result.chats.find(c => c.type === "direct");
    expect(dm).toBeDefined();
    expect(dm!.platform_id).toBe("u_001");
    expect(dm!.name).toBe("Alice");
  });
});

describe("handleGetContacts - non-friend contacts", () => {
  it("returns contacts for non-friend group members", async () => {
    const client = createMockClient({
      async getUserFriendIds() { return ["u_001"]; },
      async getContactsV3(mids) {
        return mids.map((mid) => ({ mid, displayName: `User ${mid}` }));
      },
      async getAllChatMids() {
        return { memberChatMids: ["c_001"], invitedChatMids: [] };
      },
      async getChats(chatMids) {
        return [{ chatMid: "c_001", chatName: "Group", members: ["u_001", "u_002", "u_003"] }];
      },
      myMid: "u_self",
    });

    const result = await handleGetContacts(client);

    expect(result.contacts).toHaveLength(3);
    const platformIds = result.contacts.map(c => c.platform_id);
    expect(platformIds).toContain("u_001");
    expect(platformIds).toContain("u_002");
    expect(platformIds).toContain("u_003");
  });
});

describe("ContactCache", () => {
  let cache: ContactCache;
  const contacts: CachedContact[] = [
    { mid: "u_001", displayName: "Alice Wang" },
    { mid: "u_002", displayName: "Bob 張" },
    { mid: "u_003", displayName: "小明" },
    { mid: "u_004", displayName: "張志瑋" },
  ];
  const chats: CachedChat[] = [
    { chatMid: "c_001", chatName: "Work Group" },
    { chatMid: "c_002", chatName: "家庭群組" },
  ];

  beforeEach(() => {
    cache = new ContactCache(contacts, chats);
  });

  it("get by mid returns correct contact", () => {
    expect(cache.getContact("u_001")?.displayName).toBe("Alice Wang");
  });

  it("get by mid returns undefined for unknown mid", () => {
    expect(cache.getContact("u_999")).toBeUndefined();
  });

  it("get chat by mid returns correct chat", () => {
    expect(cache.getChat("c_001")?.chatName).toBe("Work Group");
  });

  it("search contacts by name (case-insensitive)", () => {
    const results = cache.search("alice");
    expect(results).toHaveLength(1);
    expect(results[0]!.mid).toBe("u_001");
  });

  it("search includes chats", () => {
    const results = cache.search("家庭");
    expect(results).toHaveLength(1);
    expect(results[0]!.mid).toBe("c_002");
  });

  it("search contacts by Chinese name", () => {
    const results = cache.search("小明");
    expect(results).toHaveLength(1);
    expect(results[0]!.mid).toBe("u_003");
  });

  it("search returns both contacts and chats matching query", () => {
    const results = cache.search("張");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const mids = results.map((r) => r.mid);
    expect(mids).toContain("u_002");
    expect(mids).toContain("u_004");
  });

  it("search with empty query returns all items", () => {
    const results = cache.search("");
    expect(results).toHaveLength(contacts.length + chats.length);
  });

  it("refresh replaces cache contents", () => {
    cache.refresh(
      [{ mid: "u_new", displayName: "New" }],
      [{ chatMid: "c_new", chatName: "New Group" }],
    );
    expect(cache.getContact("u_001")).toBeUndefined();
    expect(cache.getContact("u_new")?.displayName).toBe("New");
  });
});
