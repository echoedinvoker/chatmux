import {
  Client,
  loginWithQR,
  loginWithAuthToken,
} from "@evex/linejs";
import { FileStorage } from "@evex/linejs/storage";
import qrcode from "qrcode-terminal";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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

export async function login(dataDir: string): Promise<Client> {
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
      console.error(
        `[AUTH] authToken login failed: ${err instanceof Error ? err.message : err}`,
      );
      console.error("[AUTH] falling back to QR login...");
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
              "[QR] open LINE on your iPhone → tap QR scanner → scan this:",
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
        console.error("[QR] expired (410), retrying...");
        continue;
      }
      throw err;
    }
  }
  throw new Error("QR login failed after max retries");
}

function setupTokenRefresh(client: Client, dataDir: string): void {
  client.base.on("update:authtoken", async (token: string) => {
    await saveAuthToken(dataDir, token);
    console.error("[AUTH] token refreshed");
  });
}
