const d=require('./eslint-out.json');
for(const f of d){for(const m of f.messages){console.log(m.line+':'+m.column+' '+(m.severity===2?'error':'warn')+' '+(m.ruleId||'')+' - '+m.message)}}
