/**
 * THE HOOK — this is the file you edit.
 *
 * chatmux core has no opinion about what is worth interrupting you for, and this
 * example deliberately has none either. It prints to stdout. Everything about
 * *policy* lives here, on your side of the MCP boundary:
 *
 *   - which chats matter (real people vs. official-account broadcasts)
 *   - where a notification goes (notify-send, ntfy, a bot, an inbox file)
 *   - throttling and dedup (an alerting integration can repeat the same line
 *     every 5 minutes; that is your problem to collapse, not core's)
 *   - quiet hours
 *
 * None of that belongs in core, because none of it has one correct answer.
 *
 * If `notify()` throws, the runner does NOT advance the cursor, so the event is
 * retried on the next poll. Delivery is at-least-once by design: for
 * notifications, a duplicate is cheaper than a miss.
 */

export interface ChatmuxEvent {
  cursor: string;
  type: string;
  message: {
    id: string;
    chat_id: string;
    sender: { id: string; display_name: string };
    timestamp: number;
    content: { type: string; text: string | null };
  };
}

export async function notify(event: ChatmuxEvent): Promise<void> {
  const { sender, chat_id, content, timestamp } = event.message;
  const when = new Date(timestamp).toISOString();

  // Printing message content is this program's entire purpose. NEVER #10 (no
  // message content in logs above debug level) constrains the core daemon, whose
  // logs are incidental — it does not constrain a consumer built to surface it.
  console.log(
    `[${when}] ${sender.display_name} in ${chat_id}: ${content.text ?? `<${content.type}>`}`,
  );

  // ---------------------------------------------------------------------------
  // Sketches of real policy. Left commented out on purpose: shipping a default
  // filter would be this example smuggling in an opinion.
  //
  // Skip broadcast-only content types:
  //   if (["rich", "flex", "none"].includes(content.type)) return;
  //
  // Allowlist specific chats:
  //   const WATCHED = new Set(["line:uXXXX", "telegram:-100YYYY"]);
  //   if (!WATCHED.has(chat_id)) return;
  //
  // Collapse a repeated alert line to once per 10 minutes:
  //   if (seenRecently(content.text, 10 * 60_000)) return;
  //
  // Desktop notification (Linux):
  //   await Bun.$`notify-send ${sender.display_name} ${content.text ?? ""}`.quiet();
  // ---------------------------------------------------------------------------
}
