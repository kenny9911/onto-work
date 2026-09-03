import { loadConfig } from "./config.js";
import { HarnessStore } from "./database.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("The bootstrap administrator reset command is disabled in production.");
}

const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() || "admin";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

if (process.env.CONFIRM_BOOTSTRAP_ADMIN_RESET !== username) {
  throw new Error(
    `Set CONFIRM_BOOTSTRAP_ADMIN_RESET=${username} to confirm this local password reset.`,
  );
}
if (!password || password.length < 8) {
  throw new Error(
    "BOOTSTRAP_ADMIN_PASSWORD must be supplied as a deployment secret and contain at least 8 characters.",
  );
}

const config = loadConfig();
const store = new HarnessStore(config.databasePath);

try {
  const user = await store.resetBootstrapAdminPassword(username, password);
  if (!user) {
    throw new Error(`No bootstrap administrator named ${username} exists.`);
  }
  process.stdout.write(
    `Bootstrap administrator password reset: ${user.username}; password change required at next login.\n`,
  );
} finally {
  store.close();
}
