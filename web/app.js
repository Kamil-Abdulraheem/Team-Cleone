
const I={
img:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="11" r="2.5"/><path d="M8 17c1-2 2.5-3 4-3s3 1 4 3"/></svg>',
pen:'<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16.5 4.5a2 2 0 0 1 3 3L8 19z"/></svg>',
globe:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>',
plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
mic:'<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
send:'<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
up:'<svg viewBox="0 0 24 24"><path d="M7 11v9H4v-9zM7 11l4-8c2 0 3 1 2.6 3L13 9h6a2 2 0 0 1 2 2.4l-1.3 7a2 2 0 0 1-2 1.6H7"/></svg>',
x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
mail:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 8l9 6 9-6"/></svg>',
back:'<svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M15 6l-6 6 6 6"/></svg>'};

const KEY='cleone.v1';
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stored=(()=>{try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){return null}})();
const S=Object.assign({graph:null,weights:{strategic:0,joiners:0},watchers:[],feed:[],seen:{},projects:{},next:1},stored||{});
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}};

const $=s=>document.querySelector(s);
let tt;const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('on'),1800)};
const nav=v=>{$('#side').classList.remove('on');({home,onboarding,watchers,dashboard})[v]()};

function home(){
$('#main').innerHTML=`<div class="home"><h1>Ready when you are.</h1><div>
<div class="rows">
<button class="row" onclick="nav('onboarding')">${I.pen}Build my identity graph</button>
<button class="row" onclick="nav('watchers')">${I.globe}Add a watcher</button>
<button class="row" onclick="nav('dashboard')">${I.img}Open my collision feed</button></div>
<div class="bar" style="margin:0"><input id="ask" placeholder="Describe who you want to meet" aria-label="Describe who you want to meet">
<div class="b"><button class="ic" aria-label="Attach">${I.plus}</button><div style="display:flex;gap:14px;align-items:center"><button class="ic" aria-label="Voice">${I.mic}</button><button class="go" id="go" aria-label="Create watcher">${I.send}</button></div></div></div></div></div>`;
$('#go').onclick=()=>{const v=$('#ask').value.trim();if(!v){nav('watchers');return}
submit(v)};
$('#ask').onkeydown=e=>{if(e.key==='Enter')$('#go').click()};
}

function onboarding(){
const g=S.graph;
$('#main').innerHTML=`<button class="back" onclick="nav('home')">${I.back}Home</button><h2>Your identity graph</h2>
<p class="sub">Paste your bio, thesis or open roles. Cleone extracts what makes you a match.</p>
<textarea id="bio" rows="7" placeholder="e.g. Former infra lead who scaled inference to 40M requests/day. Now investing pre-seed in AI infrastructure and cell-free biotech...">${esc(S.bio||'')}</textarea>
<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn ghost" id="up">Upload PDF or Markdown</button><button class="btn" id="ext">Extract graph</button></div>
<input type="file" id="file" accept=".pdf,.md,.txt" hidden>
<div id="out">${g?graphHTML(g):''}</div>`;
$('#up').onclick=()=>$('#file').click();
$('#file').onchange=e=>{const f=e.target.files[0];if(!f)return;if(f.name.endsWith('.pdf')){toast('PDF parsing needs the backend. Paste text for now.');return}
const r=new FileReader();r.onload=()=>{$('#bio').value=r.result;toast('File loaded')};r.readAsText(f)};
$('#ext').onclick=()=>{
const t=$('#bio').value.trim();if(t.length<20){toast('Add a longer bio first');return}
S.bio=t;const l=t.toLowerCase();
const pick=(m)=>m.filter(x=>l.includes(x[0])).map(x=>x[1]);
S.graph={skills:pick([['rust','Rust'],['infra','Infrastructure'],['inference','ML inference'],['python','Python'],['kubern','Kubernetes'],['vector','Vector search']]),
domains:pick([['biotech','Biotech'],['cell-free','Cell-free platforms'],['ai','Applied AI'],['fintech','Fintech'],['devtools','Developer tools']]),
wins:pick([['scaled','Scaled a system to production'],['series','Raised or joined a venture round'],['exit','Prior exit'],['led','Led a team']]),
triggers:['New release after quiet period','Call for design partners','Sole-author preprint']};
for(const k in S.graph)if(!S.graph[k].length)S.graph[k]=['(add more detail)'];
$('#out').innerHTML=graphHTML(S.graph);toast('Graph extracted (mock). Real build uses Claude.');save()};
}
function graphHTML(g){const c=(t,a)=>`<div class="lab">${t}</div><div class="chips">${a.map(x=>`<span class="chip">${x}</span>`).join('')}</div>`;
return `<div style="margin-top:20px">${c('Skills',g.skills)}${c('Domain focus',g.domains)}${c('Past wins',g.wins)}${c('Target triggers',g.triggers)}</div>`}

function watchers(){
$('#main').innerHTML=`<button class="back" onclick="nav('home')">${I.back}Home</button><h2>Watchers</h2><p class="sub">Each watcher scans public signals on a schedule.</p>
<div style="display:flex;gap:8px;margin-bottom:18px"><input class="in" id="nw" placeholder="New watcher, e.g. Rust database maintainers"><button class="btn" style="margin:0" id="aw">Add</button></div>
${S.watchers.map(w=>`<div class="card w"><div><div class="name" style="font-size:1rem">${esc(w.q)}</div><div class="lab" style="margin:2px 0 0">${esc(w.src)}</div></div><button class="sw ${w.on?'on':''}" role="switch" aria-checked="${w.on}" aria-label="Toggle watcher" onclick="tg(${w.id})"></button></div>`).join('')}`;
$('#aw').onclick=()=>{const v=$('#nw').value.trim();if(!v)return;submit(v)};
}
function tg(id){const w=S.watchers.find(x=>x.id===id);w.on=!w.on;save();watchers()}

const on=r=>{const w=S.watchers.find(x=>x.q===r);return !w||w.on};
let scanning=false;
function submit(v){
if(/^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/.test(v)){try{localStorage.setItem('cleone.token',v)}catch(e){}Cleone.setGithubToken(v);
['#ask','#nw'].forEach(s=>{const e=$(s);if(e)e.value=''});toast('GitHub token saved on this device');return}
runScan(v)}
async function runScan(input){
if(scanning){toast('A scan is already running');return}
let p;try{p=Cleone.parseRepo(input)}catch(e){toast(e.message);return}
const repo=p.owner+'/'+p.name;scanning=true;let stage='Starting scan';
const tick=()=>toast(stage+'...');tick();const iv=setInterval(tick,1500);
try{
const r=await Cleone.scan(repo,s=>{stage=s});
S.projects[repo]=r.project;
const prev=new Map(S.feed.filter(x=>x.repo===repo).map(x=>[x.k,x]));
S.feed=S.feed.filter(x=>x.repo!==repo);
for(const it of r.items){const o=prev.get(it.k);S.feed.push(Object.assign({},it,{id:o?o.id:S.next++,repo}))}
if(!S.watchers.find(w=>w.q===repo))S.watchers.unshift({id:Date.now(),q:repo,src:'GitHub',on:true});
save();clearInterval(iv);
const n=S.feed.filter(x=>x.repo===repo&&x.score>=75).length;
toast(n?'Scan complete: '+n+' collisions':'Scan complete: no matches at 75 or higher');nav('dashboard')
}catch(e){clearInterval(iv);const m=e&&e.message||'Scan failed';
toast(/rate limit/i.test(m)?'GitHub rate limit reached. Paste a GitHub token here and send it, or try later.':m)}
finally{scanning=false}}

function dashboard(){
const items=S.feed.filter(x=>!S.seen[x.id]&&x.score>=75&&on(x.repo)).sort((a,b)=>(b.score+(S.weights[b.tag]||0)*3)-(a.score+(S.weights[a.tag]||0)*3));
$('#main').innerHTML=`<button class="back" onclick="nav('home')">${I.back}Home</button><h2>Collisions this week</h2><p class="sub">Only matches scoring 75 or higher appear here.</p>
${items.length?items.map(x=>`<div class="card"><div class="top"><div><div class="name">${esc(x.name)}</div><a href="https://${esc(x.url)}" target="_blank" rel="noopener">${esc(x.art)}</a></div><div class="score">${Math.round(x.score)}</div></div>
<div class="dims"><span>Significance <b>${x.sig}</b></span><span>Resonance <b>${x.res}</b></span><span>Timing <b>${x.tim}</b></span></div>
<p class="why">${esc(x.why)}</p>
<div class="acts"><button class="p" onclick="brief(${x.id})">${I.mail}Generate outreach</button><button onclick="like(${x.id})">${I.up}Useful</button><button onclick="dismiss(${x.id})">${I.x}Dismiss</button></div></div>`).join(''):'<p class="sub">Nothing new. Add a watcher or check back after the next scan.</p>'}
<p class="lab" style="margin-bottom:24px">Preference weights: ${Object.entries(S.weights).map(([k,v])=>k+' '+(v>0?'+':'')+v).join(', ')}</p>`;
}
function open_(h){$('#panel').innerHTML=h;$('#sheet').classList.add('on')}
function close_(){$('#sheet').classList.remove('on')}
function brief(id){const x=S.feed.find(f=>f.id===id);const mail=Cleone.email(S.projects[x.repo]||{owner:'',name:x.repo,description:''},x);
open_(`<h2>Outreach for ${esc(x.name)}</h2><p class="sub">Draft references both of your work. Edit before sending.</p><div class="mail" contenteditable="true" id="m">${esc(mail)}</div><div class="acts"><button class="p" onclick="navigator.clipboard&&navigator.clipboard.writeText($('#m').innerText);toast('Copied')">Copy draft</button><button onclick="close_()">Close</button></div>`)}
function like(id){const x=S.feed.find(f=>f.id===id);S.weights[x.tag]=(S.weights[x.tag]||0)+1;save();toast('Noted. More like this.');dashboard()}
function dismiss(id){open_(`<h2>Why dismiss?</h2><p class="sub">Your reason adjusts future scoring.</p><div class="acts">${['Just noise','Wrong domain','Too early-stage','Bad timing'].map(r=>`<button onclick="doDismiss(${id},'${r}')">${r}</button>`).join('')}</div>`)}
function doDismiss(id,r){const x=S.feed.find(f=>f.id===id);S.seen[id]=1;if(r==='Wrong domain'||r==='Just noise')S.weights[x.tag]=(S.weights[x.tag]||0)-1;save();close_();toast('Dismissed: '+r);dashboard()}

$('#sheet').onclick=e=>{if(e.target.id==='sheet')close_()};
$('#menu').onclick=()=>$('#side').classList.toggle('on');
$('#theme').onclick=()=>{const r=document.documentElement;const dark=getComputedStyle(r).colorScheme==='dark';r.dataset.theme=dark?'light':'dark';
if(!dark){r.style.cssText='--bg:#161617;--surface:#202022;--ink:#f2f2f3;--mute:#8d8d93;--line:#2e2e31;--accent:#6b9cf0;--accent-soft:#1f2a40;--ok:#4cc27f;--shadow:0 2px 14px rgba(0,0,0,.4);color-scheme:dark'}else{r.style.cssText=''}};
$('#side').innerHTML=`<div class="brand">Cleone</div>
<button class="row" onclick="nav('home')">${I.pen}Home</button><button class="row" onclick="nav('onboarding')">${I.img}Identity graph</button><button class="row" onclick="nav('watchers')">${I.globe}Watchers</button><button class="row" onclick="nav('dashboard')">${I.mail}Collision feed</button>`;
try{const t=localStorage.getItem('cleone.token');if(t)Cleone.setGithubToken(t)}catch(e){}
home();
