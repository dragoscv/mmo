const fs = require("fs");
let raw = fs.readFileSync("eslint-snapshot.json","utf8");
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
const data = JSON.parse(raw.slice(start, end+1));
let errors=0, warnings=0;
const ruleErrCounts = {};
const filesWithFewErrors = [];
for (const f of data) {
  const fileErrRules = [];
  for (const m of f.messages) {
    if (m.severity===2) { errors++; if(m.ruleId){ ruleErrCounts[m.ruleId]=(ruleErrCounts[m.ruleId]||0)+1; fileErrRules.push(m.ruleId);} else { ruleErrCounts["(fatal/null)"]=(ruleErrCounts["(fatal/null)"]||0)+1; fileErrRules.push("(fatal/null)"); } }
    else if (m.severity===1) warnings++;
  }
  if (fileErrRules.length>=1 && fileErrRules.length<=3) {
    filesWithFewErrors.push({file: f.filePath, ruleIds: fileErrRules});
  }
}
const topRules = Object.entries(ruleErrCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([ruleId,count])=>({ruleId,count}));
const out = { totals:{errors,warnings}, topErrorRules: topRules, filesWith1to3Errors: filesWithFewErrors };
process.stdout.write(JSON.stringify(out,null,2));
