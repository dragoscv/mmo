import { db } from "../src/db/index";
import { devices } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
    const rows = await db.select().from(devices);
    for (const d of rows) {
        if (d.apiUrl && d.lanUrl && d.apiUrl !== d.lanUrl) {
            console.log(`Updating device ${d.id.slice(0, 8)}: apiUrl ${d.apiUrl} -> ${d.lanUrl}`);
            await db.update(devices).set({ apiUrl: d.lanUrl }).where(eq(devices.id, d.id));
        }
    }
    console.log("Done.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
