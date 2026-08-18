import {
  Client,
  loginWithQR,
  loginWithAuthToken,
} from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import qrcode from "qrcode-terminal";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { classifyLoginFailure, shouldFallBackToQr } from "./login-supervisor.js";

const MAX_QR_RETRIES = 5;

export async function saveAuthToken(dataDir: string, token: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "auth.json"), JSON.stringify({ authToken: token }));
}

export async function loadAuthToken(dataDir: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(join(dataDir, "auth.json"), "utf-8"));
    return data.authToken ?? null;
  } catch {
    return null;
  }
}

/**
 * One login attempt, and nothing more.
 *
 * The name matters: this used to be `login()`, and it used to treat *every*
 * failure of the saved token as "the token stopped working" — including "there
 * is no network yet", which is what actually happened on 2026-08-06 and
 * 2026-08-18. It then walked into a QR loop that cannot succeed under the
 * daemon, and after five tries gave up for good.
 *
 * Now the decision is explicit: classify the failure, ask `shouldFallBackToQr`,
 * and if the answer is no, rethrow untouched so the login supervisor can wait
 * and try again. Retrying is the supervisor's job; this function only ever
 * makes one attempt.
 */
export async function loginOnce(dataDir: string): Promise<Client> {
  await mkdir(dataDir, { recursive: true });
  const storage = new FileStorage(join(dataDir, "storage.json"));
  const initOpts = { device: "IOSIPAD" as const, storage };

  const savedToken = await loadAuthToken(dataDir);

  if (savedToken) {
    console.error("[AUTH] found saved token, attempting authToken login...");
    try {
      const client = await loginWithAuthToken(savedToken, initOpts);
      console.error("[AUTH] authToken login successful");
      setupTokenRefresh(client, dataDir);
      return client;
    } catch (err) {
      const kind = classifyLoginFailure(err);
      if (!shouldFallBackToQr({ hasSavedToken: true, kind })) {
        // Never mention the token itself here — only why we are not scanning.
        console.error(
          `[AUTH] the saved login did not go through, and the reason looks like a ${kind} problem rather than LINE rejecting us. Keeping the saved login and letting the retry handle it. Reason given: ${err instanceof Error ? err.message : err}`,
        );
        throw err;
      }
      console.error(
        `[AUTH] the saved login has stopped working, so we will scan a QR code again. Reason given: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  for (let attempt = 1; attempt <= MAX_QR_RETRIES; attempt++) {
    console.error(
      `[AUTH] starting QR login (attempt ${attempt}/${MAX_QR_RETRIES})...`,
    );
    try {
      const client = await loginWithQR(
        {
          onReceiveQRUrl: (url) => {
            console.error(
              "[QR] open LINE on your phone → open the QR scanner (iOS: Home → the scan icon; Android: Home → Add friends → QR code) → scan this:",
            );
            console.error("");
            qrcode.generate(url, { small: true });
            console.error(`[QR] URL: ${url}`);
            console.error(
              "[QR] QR expires in ~30s. If it expires, a new one will appear.",
            );
          },
          onPincodeRequest: (pin) => {
            console.error(`[PIN] enter this PIN on your phone: ${pin}`);
          },
        },
        initOpts,
      );
      console.error("[AUTH] QR login successful");
      await saveAuthToken(dataDir, client.authToken);
      setupTokenRefresh(client, dataDir);
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("410") && attempt < MAX_QR_RETRIES) {
        console.error("[QR] that QR code expired before it was scanned. A new one follows.");
        continue;
      }
      console.error(
        "[AUTH] QR login failed, and not because the code expired. If this repeats: check that " +
          "the LINE account is not blocked (README → Account Risk Warning), or start the daemon " +
          "with no adapters configured (README → Quickstart step 2) to confirm the rest works.",
      );
      throw err;
    }
  }
  throw new Error(
    `QR login failed after ${MAX_QR_RETRIES} attempts. Running the command again gives you a ` +
      "fresh QR code; if it keeps failing, see README → Account Risk Warning.",
  );
}

function setupTokenRefresh(client: Client, dataDir: string): void {
  client.base.on("update:authtoken", async (token: string) => {
    await saveAuthToken(dataDir, token);
    console.error("[AUTH] token refreshed");
  });
}
