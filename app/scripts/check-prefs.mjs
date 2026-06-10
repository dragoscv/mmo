import Database from "better-sqlite3";
const db = new Database("./data/app.db", { readonly: false });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("tables:", tables.map((t) => t.name).join(", "));
const aiPrefsTable = tables.find((t) => t.name.includes("ai_pref") || t.name.includes("aiPref"));
if (aiPrefsTable) {
  const rows = db.prepare(`SELECT * FROM "${aiPrefsTable.name}"`).all();
  console.log(`${aiPrefsTable.name}:`, JSON.stringify(rows, null, 2));
}
