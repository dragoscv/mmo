import { db } from "../src/db/index";
import { devices } from "../src/db/schema";

async function main() {
    const r = await db.select().from(devices);
    console.log(JSON.stringify(r.map(d => ({
        id: d.id.slice(0, 8),
        userId: d.userId.slice(0, 8),
        apiUrl: d.apiUrl,
        lanUrl: d.lanUrl,
        hasToken: !!d.tokenEncrypted,
        lastSeen: d.lastSeenAt,
    })), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
