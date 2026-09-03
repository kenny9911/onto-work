import { loadConfig } from "./config.js";
import { HarnessStore } from "./database.js";

const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || "admin";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

if (!password || password.length < 8) {
  throw new Error(
    "BOOTSTRAP_ADMIN_PASSWORD must be supplied as a deployment secret and contain at least 8 characters.",
  );
}

const config = loadConfig();
const store = new HarnessStore(config.databasePath);

try {
  const existing = store.getUserByUsername(username);
  const user = await store.bootstrapAdmin(username, password);
  process.stdout.write(
    existing
      ? `Bootstrap administrator already exists: ${user.username}\n`
      : `Bootstrap administrator created: ${user.username}; password change required at first login.\n`,
  );
} finally {
  store.close();
}

