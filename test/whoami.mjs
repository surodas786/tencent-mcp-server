// Shows who this machine's key belongs to, without printing the key.
// Use it to find the real TENCENTDB_USER_ID. Run: npm run whoami
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const { TENCENTDB_PANEL_URL, TENCENTDB_USER_KEY, TENCENTDB_API_KEY, TENCENTDB_SERVICE_ID } = process.env;
if (!TENCENTDB_PANEL_URL) throw new Error("Set TENCENTDB_PANEL_URL in .env first.");

const key = TENCENTDB_USER_KEY || TENCENTDB_API_KEY;
const response = await fetch(`${TENCENTDB_PANEL_URL.replace(/\/+$/, "")}/api/v1/meta/auth/verify`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-tdai-service-id": TENCENTDB_SERVICE_ID || "default",
    "x-tdai-user-key": key,
  },
  body: JSON.stringify({ user_key: key }),
});
const { data } = await response.json();
if (!data?.valid) {
  console.log("Key rejected.");
  process.exit(1);
}
console.log(data.user);
if (data.user.user_type === "system_admin") {
  console.log("STOP: this is an admin key. Do not use it on a developer workstation.");
  process.exit(2);
}
