(function(){try{var d=document.documentElement,ls=window.localStorage,K="mixai:prefs:v1",H={"violet":285,"magenta":330,"cyan":200,"emerald":160,"amber":75,"rose":15},DEF={"mode":"system","accent":"violet","surface":"glass","density":"comfortable","radius":"md","motion":"full","locale":"ro","feedback":false};
var raw=ls.getItem(K),p=null;try{p=raw?JSON.parse(raw):null}catch(e){}
if(!p){p={};var t=ls.getItem("theme");if(t==="light"||t==="dark"||t==="system")p.mode=t;
var mu=ls.getItem("mixai-ui");if(mu){try{var m=JSON.parse(mu);var s=m&&m.state?m.state:m;if(s&&s.motion==="minimal")p.motion="reduced";if(s&&s.theme==="flat-pro")p.surface="flat";if(s&&s.theme==="studio-metal")p.surface="solid"}catch(e){}}
var lc=document.cookie.match(/(?:^|; )mmo-locale=(ro|en)/);if(lc)p.locale=lc[1];}
for(var k in DEF)if(p[k]==null)p[k]=DEF[k];
var mode=p.mode==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p.mode;
d.setAttribute("data-mode",mode);d.classList.remove("light","dark");d.classList.add(mode);d.style.colorScheme=mode;
var ac=String(p.accent),hue=null,attr=ac;if(ac==="artwork"){attr="artwork"}else if(ac.indexOf("custom:")===0){attr="custom";hue=Number(ac.slice(7))}else{hue=H[ac]!=null?H[ac]:H.violet;if(H[ac]==null)attr="violet"}
d.setAttribute("data-accent",attr);if(hue!=null&&isFinite(hue))d.style.setProperty("--accent-h",String(((hue%360)+360)%360));
var coarse=window.matchMedia&&window.matchMedia("(pointer: coarse)").matches;
d.setAttribute("data-surface",p.surface==="glass"&&coarse&&!raw?"solid":p.surface);
d.setAttribute("data-density",p.density);d.setAttribute("data-radius",p.radius);
var rm=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
d.setAttribute("data-motion",rm?"reduced":p.motion);d.setAttribute("lang",p.locale||"ro");
if(!raw)ls.setItem(K,JSON.stringify(p));}catch(e){}})();
