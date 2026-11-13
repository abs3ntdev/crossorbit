export const CSS = `
:root{--ink:#12141c;--slab:#1b1e2a;--edge:#2a2e3e;--paper:#dcd7c9;--dim:#8a8d9c;--marker:#f0d64a;--ember:#e8875b;--ash:#666a7c;--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#1f2335 0,transparent 60%),var(--ink);color:var(--paper);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}
a{color:inherit}
a:focus-visible{outline:2px solid var(--marker);outline-offset:3px;border-radius:4px}
.top{display:flex;align-items:baseline;gap:2rem;padding:1.4rem clamp(1rem,4vw,3rem) .6rem;flex-wrap:wrap}
.mark{font-family:var(--serif);font-style:italic;font-size:1.6rem;text-decoration:none;letter-spacing:-.01em}
.mark::after{content:"";display:inline-block;width:.45em;height:.45em;margin-left:.2em;border-radius:50%;background:var(--marker);box-shadow:0 0 12px var(--marker)}
nav{display:flex;gap:1.2rem}
nav a{text-decoration:none;color:var(--dim);padding-bottom:2px;border-bottom:2px solid transparent}
nav a:hover{color:var(--paper)}
nav a[aria-current=page]{color:var(--paper);border-color:var(--marker)}
.health{display:flex;flex-wrap:wrap;gap:.4rem 1.4rem;padding:.55rem clamp(1rem,4vw,3rem);border-block:1px solid var(--edge);background:#161924;font:12px/1.4 var(--mono);color:var(--dim)}
.health time{color:var(--paper)}
.lamp i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:.45em;vertical-align:1px}
.lamp.on i{background:#7bd88f;box-shadow:0 0 8px #7bd88f}
.lamp.off{color:var(--ember)}.lamp.off i{background:var(--ember)}
main{padding:1.5rem clamp(1rem,4vw,3rem) 4rem;max-width:1200px}
h1{font:400 clamp(2rem,5vw,3.2rem)/1.05 var(--serif);margin:.4rem 0 1.4rem;letter-spacing:-.02em}
h2{font:600 .75rem/1 var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--dim);margin:2.4rem 0 1rem}
.dim{color:var(--dim);margin:.2rem 0}
.mono{font-family:var(--mono);font-size:12px;word-break:break-all}
.empty{border:1px dashed var(--edge);border-radius:10px;padding:2rem;color:var(--dim);text-align:center;font-family:var(--serif);font-style:italic;font-size:1.1rem}
.warn{color:var(--ember)}
.shelf{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:1.2rem}
.card{display:flex;gap:1rem;padding:1rem;border-radius:12px;background:var(--slab);border:1px solid var(--edge);text-decoration:none;height:100%;transition:transform .2s,border-color .2s}
.card:hover{transform:translateY(-2px);border-color:#3c4258}
.cover{position:relative;flex:none;width:84px;aspect-ratio:2/3;border-radius:3px 6px 6px 3px;background:linear-gradient(135deg,#2b3047,#1a1d29);overflow:hidden;box-shadow:inset 3px 0 0 rgba(255,255,255,.06),0 6px 18px rgba(0,0,0,.45)}
.cover img{width:100%;height:100%;object-fit:cover;display:block}
.ribbon{position:absolute;right:8px;top:0;width:9px;max-height:100%;background:var(--marker);clip-path:polygon(0 0,100% 0,100% 100%,50% calc(100% - 5px),0 100%);box-shadow:0 0 10px rgba(240,214,74,.5)}
.meta{min-width:0;display:flex;flex-direction:column}
.meta h2{font:500 1.15rem/1.2 var(--serif);text-transform:none;letter-spacing:0;color:var(--paper);margin:0 0 .2rem}
.by{color:var(--dim);font-style:italic;font-family:var(--serif);margin:0 0 .4rem}
.pct{font:600 1.3rem/1 var(--mono);margin:.3rem 0;color:var(--marker)}
.pct.big{font-size:2.4rem;margin:1rem 0 .6rem}
.tally{display:flex;flex-wrap:wrap;gap:.3rem;margin:auto 0 0;padding-top:.6rem;font:11px var(--mono)}
.tally span{padding:.1rem .45rem;border-radius:99px;background:#232736}
.tally .synced{color:var(--marker)}.tally .unanchored{color:var(--ember)}.tally .deleted{color:var(--ash)}
.hero{display:flex;gap:2rem;align-items:flex-start;flex-wrap:wrap}
.hero>div{flex:1;min-width:260px}
.hero h1{margin-top:0}
.cover.big{width:min(180px,40vw);height:auto}
.bar{height:6px;border-radius:99px;background:#262a3a;overflow:hidden;min-width:80px;display:inline-block;width:100%;max-width:520px;vertical-align:middle}
.bar span{display:block;height:100%;background:linear-gradient(90deg,#b39c2c,var(--marker));border-radius:inherit}
td .bar{width:120px}
.clips{list-style:none;padding:0;margin:0;display:grid;gap:.8rem}
.clips li{padding:1rem 1.2rem;border-radius:10px;background:var(--slab);border-left:3px solid var(--marker)}
.clips li.unanchored{border-color:var(--ember)}.clips li.deleted{border-color:var(--ash);opacity:.7}
.row{display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;font-size:13px}
.chapter{color:var(--dim);font-family:var(--serif);font-style:italic}
blockquote{margin:.7rem 0;font:1.08rem/1.6 var(--serif)}
.synced blockquote{background:linear-gradient(transparent 55%,rgba(240,214,74,.28) 55%);-webkit-box-decoration-break:clone;box-decoration-break:clone;display:inline}
.deleted blockquote{text-decoration:line-through;text-decoration-color:var(--ash)}
.clips .mono{margin-top:.6rem}
.badge{font:600 10px/1 var(--mono);text-transform:uppercase;letter-spacing:.1em;padding:.3rem .5rem;border-radius:4px}
.badge.synced{background:rgba(240,214,74,.14);color:var(--marker)}
.badge.unanchored{background:rgba(232,135,91,.16);color:var(--ember)}
.badge.deleted{background:#262a38;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font:600 11px var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--dim);padding:.5rem;border-bottom:1px solid var(--edge)}
td{padding:.6rem .5rem;border-bottom:1px solid #20232f;vertical-align:middle}
@media (max-width:640px){table,thead,tbody,tr,td{display:block}thead{display:none}tr{padding:.6rem 0;border-bottom:1px solid var(--edge)}td{border:0;padding:.15rem 0}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
