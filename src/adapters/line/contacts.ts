export interface CachedContact {
  mid: string;
  displayName: string;
}

export interface CachedChat {
  chatMid: string;
  chatName: string;
  members?: string[];
}

export interface ContactClient {
  getUserFriendIds(): Promise<string[]>;
  getContactsV3(mids: string[]): Promise<CachedContact[]>;
  getAllChatMids(): Promise<{ memberChatMids: string[]; invitedChatMids: string[] }>;
  getChats(chatMids: string[]): Promise<CachedChat[]>;
  getMessageBoxes?(): Promise<{ id: string; lastDeliveredTime: number }[]>;
  myMid?: string;
}

const BATCH_SIZE = 100;

export async function fetchContactsByMids(
  client: ContactClient,
  mids: string[],
): Promise<CachedContact[]> {
  if (mids.length === 0) return [];

  const results: CachedContact[] = [];
  for (let i = 0; i < mids.length; i += BATCH_SIZE) {
    const batch = mids.slice(i, i + BATCH_SIZE);
    const contacts = await client.getContactsV3(batch);
    results.push(...contacts);
  }
  return results;
}

export async function fetchContactsBatched(
  client: ContactClient,
): Promise<CachedContact[]> {
  const mids = await client.getUserFriendIds();
  return fetchContactsByMids(client, mids);
}

export async function fetchAllContacts(
  client: ContactClient,
): Promise<CachedContact[]> {
  const friendContacts = await fetchContactsBatched(client);
  const friendMids = new Set(friendContacts.map((c) => c.mid));

  const chats = await fetchChats(client);
  const groupMemberMids = new Set<string>();
  for (const chat of chats) {
    if (chat.members) {
      for (const mid of chat.members) {
        groupMemberMids.add(mid);
      }
    }
  }

  const dmMids = new Set<string>();
  if (client.getMessageBoxes) {
    const boxes = await client.getMessageBoxes();
    for (const box of boxes) {
      if (box.id.startsWith("u")) {
        dmMids.add(box.id);
      }
    }
  }

  const unknownMids = [
    ...new Set([...groupMemberMids, ...dmMids]),
  ].filter((mid) => !friendMids.has(mid) && mid !== client.myMid);

  const unknownContacts = await fetchContactsByMids(client, unknownMids);
  return [...friendContacts, ...unknownContacts];
}

export async function fetchChats(client: ContactClient): Promise<CachedChat[]> {
  const { memberChatMids } = await client.getAllChatMids();
  if (memberChatMids.length === 0) return [];
  return client.getChats(memberChatMids);
}

export async function handleGetContacts(client: ContactClient) {
  const contacts = await fetchAllContacts(client);
  return {
    contacts: contacts.map((c) => ({
      platform_id: c.mid,
      display_name: c.displayName,
      raw: c,
    })),
  };
}

export async function handleGetChats(
  client: ContactClient,
  contactsMap?: Map<string, string>,
) {
  const groups = await fetchChats(client);
  const groupMids = new Set(groups.map((g) => g.chatMid));

  const result: { platform_id: string; type: "group" | "direct"; name: string | null; raw?: unknown }[] =
    groups.map((c) => ({
      platform_id: c.chatMid,
      type: "group" as const,
      name: c.chatName,
      raw: c,
    }));

  if (client.getMessageBoxes) {
    const boxes = await client.getMessageBoxes();
    for (const box of boxes) {
      if (box.id.startsWith("u")) {
        result.push({
          platform_id: box.id,
          type: "direct",
          name: contactsMap?.get(box.id) ?? null,
        });
      } else if (!groupMids.has(box.id)) {
        result.push({
          platform_id: box.id,
          type: "group",
          name: null,
        });
      }
    }
  }

  return { chats: result };
}

const MID_PATTERN = /^[uc][0-9a-f]{7}/;

export async function enrichSenderName(
  senderMid: string,
  cache: ContactCache,
  client: ContactClient,
): Promise<string> {
  const cached = cache.getContact(senderMid);
  if (cached) return cached.displayName;

  try {
    const contacts = await client.getContactsV3([senderMid]);
    const contact = contacts[0];
    if (contact && contact.displayName && !MID_PATTERN.test(contact.displayName)) {
      cache.addContacts([contact]);
      return contact.displayName;
    }
  } catch {}

  return senderMid;
}

interface SearchResult {
  mid: string;
  displayName: string;
}

export class ContactCache {
  private contacts = new Map<string, CachedContact>();
  private chats = new Map<string, CachedChat>();

  constructor(contacts: CachedContact[], chats: CachedChat[]) {
    this.loadContacts(contacts);
    this.loadChats(chats);
  }

  getContact(mid: string): CachedContact | undefined {
    return this.contacts.get(mid);
  }

  getChat(chatMid: string): CachedChat | undefined {
    return this.chats.get(chatMid);
  }

  search(query: string): SearchResult[] {
    const q = query.toLowerCase();
    const results: SearchResult[] = [];

    for (const c of this.contacts.values()) {
      if (q === "" || c.displayName.toLowerCase().includes(q)) {
        results.push({ mid: c.mid, displayName: c.displayName });
      }
    }
    for (const c of this.chats.values()) {
      if (q === "" || c.chatName.toLowerCase().includes(q)) {
        results.push({ mid: c.chatMid, displayName: c.chatName });
      }
    }

    return results;
  }

  addContacts(contacts: CachedContact[]): void {
    for (const c of contacts) {
      if (!this.contacts.has(c.mid)) {
        this.contacts.set(c.mid, c);
      }
    }
  }

  refresh(contacts: CachedContact[], chats: CachedChat[]): void {
    this.contacts.clear();
    this.chats.clear();
    this.loadContacts(contacts);
    this.loadChats(chats);
  }

  private loadContacts(contacts: CachedContact[]): void {
    for (const c of contacts) {
      this.contacts.set(c.mid, c);
    }
  }

  private loadChats(chats: CachedChat[]): void {
    for (const c of chats) {
      this.chats.set(c.chatMid, c);
    }
  }
}
