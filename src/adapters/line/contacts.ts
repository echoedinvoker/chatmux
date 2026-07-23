export interface CachedContact {
  mid: string;
  displayName: string;
}

export interface CachedChat {
  chatMid: string;
  chatName: string;
}

export interface ContactClient {
  getUserFriendIds(): Promise<string[]>;
  getContactsV3(mids: string[]): Promise<CachedContact[]>;
  getAllChatMids(): Promise<{ memberChatMids: string[]; invitedChatMids: string[] }>;
  getChats(chatMids: string[]): Promise<CachedChat[]>;
}

const BATCH_SIZE = 100;

export async function fetchContactsBatched(
  client: ContactClient,
): Promise<CachedContact[]> {
  const mids = await client.getUserFriendIds();
  if (mids.length === 0) return [];

  const results: CachedContact[] = [];
  for (let i = 0; i < mids.length; i += BATCH_SIZE) {
    const batch = mids.slice(i, i + BATCH_SIZE);
    const contacts = await client.getContactsV3(batch);
    results.push(...contacts);
  }
  return results;
}

export async function fetchChats(client: ContactClient): Promise<CachedChat[]> {
  const { memberChatMids } = await client.getAllChatMids();
  if (memberChatMids.length === 0) return [];
  return client.getChats(memberChatMids);
}

export async function handleGetContacts(client: ContactClient) {
  const contacts = await fetchContactsBatched(client);
  return {
    contacts: contacts.map((c) => ({
      platform_id: c.mid,
      display_name: c.displayName,
      raw: c,
    })),
  };
}

export async function handleGetChats(client: ContactClient) {
  const chats = await fetchChats(client);
  return {
    chats: chats.map((c) => ({
      platform_id: c.chatMid,
      type: "group" as const,
      name: c.chatName,
      raw: c,
    })),
  };
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
