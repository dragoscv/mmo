const fs=require('fs');
let raw=fs.readFileSync('eslint-snapshot.json','utf8');
const i=raw.indexOf('[');
const j=raw.lastIndexOf(']');
raw=raw.slice(i,j+1);
const data=JSON.parse(raw);
const rules=['react-hooks/rules-of-hooks','react-hooks/purity','react-hooks/preserve-manual-memoization','react-hooks/globals','react-hooks/static-components'];
for(const r of rules){
  console.log('=== '+r+' ===');
  let n=0;
  for(const f of data){
    for(const m of (f.messages||[])){
      if(m.ruleId===r){console.log(f.filePath+':'+m.line+(m.column?':'+m.column:''));n++;}
    }
  }
  console.log('('+n+' occurrences)');
  console.log();
}
