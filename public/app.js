// Cleone front end. Plain JavaScript, no build step. Screens are functions that fill <main id="main">.
// Sections: helpers -> account screens -> home and scan -> radar -> plan -> settings -> start-up.

const I = {
scan:'<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
radar:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 12l6-6"/></svg>',
bell:'<svg viewBox="0 0 24 24"><path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4"/></svg>',
send:'<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
mail:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 8l9 6 9-6"/></svg>',
up:'<svg viewBox="0 0 24 24"><path d="M7 11v9H4v-9zM7 11l4-8c2 0 3 1 2.6 3L13 9h6a2 2 0 0 1 2 2.4l-1.3 7a2 2 0 0 1-2 1.6H7"/></svg>',
x:'<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
lock:'<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
back:'<svg viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M15 6l-6 6 6 6"/></svg>',
plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
gear:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>',
briefcase:'<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
sliders:'<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
out:'<svg viewBox="0 0 24 24"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9"/></svg>'};

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let tt;
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2200); };
const open_ = h => { $('#panel').innerHTML = h; $('#sheet').classList.add('on'); };
const close_ = () => $('#sheet').classList.remove('on');
const fmtDate = sec => new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// App state. Nothing sensitive is kept in the browser: the server holds the session and the data.
const S = { me: null, cfg: {}, radar: null, tab: 'strategic', recent: [], busy: false };
const FAKE = { name: 'Hidden match', kind: 'Unlock to see who', sig: 'Signal hidden until you upgrade', score: 88, sig_: 84, res: 90, tim: 89,
  why: 'This match is hidden on the Free plan. Upgrade to Pro to see who it is, why it scores this high, and to draft outreach.' };

/** Talks to the backend. Throws an Error with a readable message on any failure. */
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api' + path, { method: opts.method || 'GET', credentials: 'same-origin',
      headers: opts.body ? { 'content-type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch (e) { throw new Error('No connection. Check your internet and try again.'); }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && !path.startsWith('/auth/')) { S.me = null; auth('login'); throw new Error('Please log in'); }
  if (!res.ok) { const err = new Error(data.error || 'Something went wrong'); err.status = res.status; throw err; }
  return data;
}

const nav = v => { $('#side').classList.remove('on'); if (!S.me && v !== 'auth') return auth('login'); ({ home, radar, alerts, settings, features, jobs, jobAlerts })[v](); };

function theme(t) {
  const r = document.documentElement;
  if (t === 'light' || t === 'dark') r.dataset.theme = t; else delete r.dataset.theme;
  try { localStorage.setItem('cleone.theme', t || 'system'); } catch (e) {}
}

function chrome(signedIn) {
  $('#menu').style.visibility = signedIn ? 'visible' : 'hidden';
  $('#upg').style.display = signedIn && S.me && S.me.plan === 'free' ? '' : 'none';
}

// ============================================================ account screens

function auth(mode) {
  chrome(false);
  const up = mode === 'signup';
  $('#main').innerHTML = `<div class="home"><h1>${up ? 'Create your account' : 'Welcome back'}</h1><div>
<p class="sub center">${up ? 'Free to start. 3 scans a month, no card needed.' : 'Log in to see who is paying attention to your project.'}</p>
${up ? '<div class="field"><label for="nm">Name</label><input class="in" id="nm" autocomplete="name" placeholder="Your name"></div>' : ''}
<div class="field"><label for="em">Email</label><input class="in" id="em" type="email" autocomplete="email" autocapitalize="off" placeholder="you@startup.com"></div>
<div class="field"><label for="pw">Password</label><input class="in" id="pw" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" placeholder="${up ? 'At least 8 characters' : 'Your password'}"></div>
<div class="err" id="er" role="alert"></div>
<button class="btn" id="ok" style="width:100%">${up ? 'Create account' : 'Log in'}</button>
<div class="center" style="margin-top:12px"><button class="lnk" id="sw">${up ? 'I already have an account' : 'Create an account'}</button>${up ? '' : ' &nbsp; <button class="lnk" id="fg">Forgot password?</button>'}</div></div></div>`;
  $('#sw').onclick = () => auth(up ? 'login' : 'signup');
  if (!up) $('#fg').onclick = forgot;
  const submit = async () => {
    $('#er').textContent = ''; $('#ok').disabled = true;
    try {
      const body = { email: $('#em').value, password: $('#pw').value };
      if (up) body.name = $('#nm').value;
      S.me = await api(up ? '/auth/signup' : '/auth/login', { method: 'POST', body });
      await session(); home();
    } catch (e) { $('#er').textContent = e.message; $('#ok').disabled = false; }
  };
  $('#ok').onclick = submit;
  $('#pw').onkeydown = e => { if (e.key === 'Enter') submit(); };
}

function forgot() {
  $('#main').innerHTML = `<button class="back" id="bk">${I.back}Log in</button><h2>Reset your password</h2>
<p class="sub">Enter your email and we will send you a link.</p>
<div class="field"><label for="em">Email</label><input class="in" id="em" type="email" autocapitalize="off" placeholder="you@startup.com"></div>
<div class="err" id="er" role="alert"></div><button class="btn" id="ok">Send reset link</button>`;
  $('#bk').onclick = () => auth('login');
  $('#ok').onclick = async () => {
    try {
      const r = await api('/auth/forgot', { method: 'POST', body: { email: $('#em').value } });
      $('#er').textContent = r.emailed ? 'If that email has an account, a reset link is on its way.' : 'Password reset by email is not switched on yet. Contact support to reset your password.';
    } catch (e) { $('#er').textContent = e.message; }
  };
}

function resetScreen(token) {
  chrome(false);
  $('#main').innerHTML = `<h2 style="margin-top:12vh">Choose a new password</h2><p class="sub">At least 8 characters.</p>
<div class="field"><label for="pw">New password</label><input class="in" id="pw" type="password" autocomplete="new-password"></div>
<div class="err" id="er" role="alert"></div><button class="btn" id="ok">Save password</button>`;
  $('#ok').onclick = async () => {
    try {
      await api('/auth/reset', { method: 'POST', body: { token, password: $('#pw').value } });
      history.replaceState(null, '', location.pathname); toast('Password changed. Log in with it.'); auth('login');
    } catch (e) { $('#er').textContent = e.message; }
  };
}

async function logout() { try { await api('/auth/logout', { method: 'POST' }); } catch (e) {} S.me = null; S.radar = null; close_(); auth('login'); }

// ============================================================ side menu and session

async function session() {
  theme((S.me.prefs && S.me.prefs.theme) || 'system');
  chrome(true);
  try { S.recent = (await api('/scans')).scans.map(s => s.repo); } catch (e) { S.recent = []; }
  side();
}

function side() {
  const n = S.me.user.name || S.me.user.email, f = S.me.features || { repo: true };
  $('#side').innerHTML = `<div class="hd">Cleone</div>
${f.repo ? `<button class="row" onclick="nav('home')">${I.scan}Scan a repo</button><button class="row" onclick="nav('radar')">${I.radar}Radar</button>` : ''}
${f.jobs ? `<button class="row" onclick="nav('jobs')">${I.briefcase}Job Radar</button><button class="row" onclick="nav('jobAlerts')">${I.bell}Job alerts</button>` : ''}
<button class="row" onclick="nav('features')">${I.sliders}Features</button><button class="row" onclick="nav('alerts')">${I.bell}${S.me.plan === 'pro' ? 'Your plan' : 'Upgrade plan'}</button>
${f.repo && S.recent.length ? '<div class="rec">Recent</div>' + S.recent.map(r => `<button class="row sm" onclick="openRepo('${esc(r)}')">${I.radar}${esc(r)}</button>`).join('') : ''}
<button class="me" onclick="menu()"><span class="av">${esc(n.trim().charAt(0).toUpperCase())}</span><span><b>${esc(n)}</b><small>${esc(S.me.planLabel)} plan</small></span></button>`;
}

function menu() {
  open_(`<div class="acts" style="flex-direction:column;align-items:stretch;gap:2px">
<button class="row" style="color:var(--ink)" onclick="close_();nav('settings')">${I.gear}Settings</button>
${S.me.plan === 'free' ? `<button class="row" style="color:var(--ink)" onclick="close_();nav('alerts')">${I.bell}Upgrade plan</button>` : ''}
<button class="row" style="color:var(--ink)" onclick="logout()">${I.out}Log out</button></div>`);
}

async function openRepo(repo) { $('#side').classList.remove('on'); S.tab = 'strategic'; await radar(repo); }

// ============================================================ home and scan

function home() {
  chrome(true);
  if (S.me.features && !S.me.features.repo) return S.me.features.jobs ? jobs() : features();
  $('#main').innerHTML = `<div class="home"><h1>Ready when you are.</h1><div>
<button class="row" onclick="$('#url').focus()">${I.scan}Scan my repo</button>
<button class="row" onclick="nav('radar')">${I.radar}Open my radar</button>
<button class="row" onclick="nav('alerts')">${I.bell}${S.me.plan === 'pro' ? 'Your plan' : 'Upgrade to Pro'}</button>
<div class="bar"><input id="url" placeholder="Paste your GitHub repo URL" aria-label="GitHub repo URL" autocapitalize="off">
<div class="b"><button class="ic" aria-label="Add" id="add">${I.plus}</button><button class="go" id="go" aria-label="Scan">${I.send}</button></div></div></div></div>`;
  $('#go').onclick = scan; $('#url').onkeydown = e => { if (e.key === 'Enter') scan(); };
  $('#add').onclick = () => { if (S.recent[0]) { $('#url').value = 'github.com/' + S.recent[0]; toast('Last scanned repo filled in'); } else toast('Paste a link like github.com/owner/name'); };
}

async function scan() {
  if (S.busy) return;
  const v = $('#url').value.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const m = v.match(/^(?:github\.com\/)?([\w.-]+)\/([\w.-]+)$/i);
  if (!m) { toast('Enter a repo like github.com/owner/name'); return; }
  const repo = m[1] + '/' + m[2];
  S.busy = true;
  const claude = S.cfg.scorer === 'claude' && S.me.plan === 'pro';
  $('#main').innerHTML = `<h2>Scanning ${esc(m[2])}</h2><p class="sub">Reading public GitHub activity. This usually takes under a minute.</p><div class="steps" id="st"><p>Reading your README and recent commits</p><p>Finding forks, stars and dependents</p><p>Checking companies and investors near your space</p><p>Scoring each match${claude ? ' with Claude' : ''}</p></div>`;
  const lines = [...document.querySelectorAll('#st p')];
  try {
    const start = await api('/scans', { method: 'POST', body: { repo } });
    for (let i = 0; i < 40; i++) {
      const r = await api(`/scans/${start.id}/step`, { method: 'POST' });
      lines.forEach((p, n) => p.classList.toggle('done', n < r.line));
      if (r.done) break;
    }
    S.me = await api('/me'); side();
    setTimeout(() => { S.busy = false; S.tab = 'strategic'; radar(repo); }, 500);
  } catch (e) {
    S.busy = false;
    if (!S.me) return;
    $('#main').innerHTML = `<button class="back" onclick="nav('home')">${I.back}Home</button><h2>Scan could not finish</h2><p class="sub">${esc(e.message)}</p>${e.status === 402 ? `<button class="btn" onclick="nav('alerts')">See Pro</button>` : `<button class="btn" onclick="nav('home')">Try again</button>`}`;
  }
}

// ============================================================ radar

const inner = x => `<div class="top"><div><div class="name">${esc(x.name)}</div><div class="kind">${esc(x.kind)}</div></div><div class="score">${Math.round(x.score)}</div></div>
<div class="dims"><span>Significance <b>${x.sig_}</b></span><span>Fit <b>${x.res}</b></span><span>Timing <b>${x.tim}</b></span></div>
<div class="sig">${esc(x.sig)}</div><p class="why">${esc(x.why)}</p>`;
const card = x => `<div class="card tap" role="button" tabindex="0" onclick="detail('${esc(x.id)}')" onkeydown="if(event.key==='Enter')detail('${esc(x.id)}')">${inner(x)}<div class="acts" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()"><button class="p" onclick="brief('${esc(x.id)}')">${I.mail}Draft outreach</button><button onclick="like('${esc(x.id)}')">${I.up}Useful</button><button onclick="dismiss('${esc(x.id)}')">${I.x}Dismiss</button></div></div>`;
const lockedCard = x => `<div class="card lock"><div class="blur">${inner(FAKE)}</div><div class="ov">${I.lock}<b>${x.high ? 'High-scoring match hidden' : 'Match hidden'}</b><button class="btn" onclick="nav('alerts')">Unlock with Pro</button></div></div>`;

async function radar(repo) {
  if (!S.me) return auth('login');
  chrome(true);
  let r;
  try { r = await api('/radar' + (repo ? '?repo=' + encodeURIComponent(repo) : '')); } catch (e) { toast(e.message); return; }
  S.radar = r;
  if (!r.repo) { $('#main').innerHTML = `<h2>No scan yet</h2><p class="sub">Paste a repo on the home screen to see who is paying attention.</p><button class="btn" onclick="nav('home')">Scan a repo</button>`; return; }
  const names = { strategic: 'Partners and acquirers', joiners: 'Joiners', investors: 'Investors' };
  const L = r.lanes[S.tab];
  const note = (r.scorer === 'claude' ? 'Scored with Claude from public GitHub data.' : 'Rule-based scores from public GitHub data.') + (r.plan === 'free' ? ' The Free plan unlocks 1 match per lane.' : '');
  const empty = S.tab === 'investors' ? 'No investor-like profiles have starred or forked this repo yet. They appear here when they do.' : 'Nothing new here.';
  $('#main').innerHTML = `<button class="back" onclick="nav('home')">${I.back}Home</button><h2>${esc(r.repo)}</h2><p class="sub">Who is paying attention this week</p>
<div class="note">${note}</div>
<div class="tabs" role="tablist">${Object.keys(names).map(k => `<button class="${S.tab === k ? 'on' : ''}" onclick="S.tab='${k}';radar('${esc(r.repo)}')">${names[k]}</button>`).join('')}</div>
${L.items.map(card).join('')}${L.locked.map(lockedCard).join('')}${L.items.length + L.locked.length ? '' : `<p class="sub">${empty}</p>`}
<p class="sub" style="font-size:.88rem;margin-bottom:24px">${L.below} weak match${L.below === 1 ? '' : 'es'} below ${r.cutoff} filtered out.</p>`;
}

const reload = () => radar(S.radar && S.radar.repo);

async function brief(id) {
  try {
    const r = await api(`/matches/${id}/draft`, { method: 'POST' });
    const name = [...S.radar.lanes[S.tab].items].find(x => x.id === id)?.name || '';
    open_(`<h2>Outreach to ${esc(name)}</h2><p class="sub">References your work and theirs. Edit before sending.</p><div class="mail" contenteditable="true" id="m">${esc(r.email)}</div>${r.contact ? `<p class="sub" style="font-size:.88rem">Public contact: ${esc(r.contact)}</p>` : ''}<div class="acts"><button class="p" id="cp">Copy draft</button><button onclick="close_()">Close</button></div>`);
    $('#cp').onclick = () => { try { navigator.clipboard && navigator.clipboard.writeText($('#m').innerText); } catch (e) {} toast('Copied'); api(`/matches/${id}/copied`, { method: 'POST' }).catch(() => {}); };
  } catch (e) { toast(e.message); }
}
async function like(id) { try { await api(`/matches/${id}/feedback`, { method: 'POST', body: { action: 'like' } }); toast('Noted. More like this.'); reload(); } catch (e) { toast(e.message); } }
function dismiss(id) { open_(`<h2>Why dismiss?</h2><p class="sub">Your reason adjusts future scoring.</p><div class="acts">${['Not relevant', 'Too early', 'Bad timing', 'Already know them'].map(r => `<button onclick="dd('${esc(id)}','${r}')">${r}</button>`).join('')}</div>`); }
async function dd(id, r) { try { await api(`/matches/${id}/feedback`, { method: 'POST', body: { action: 'dismiss', reason: r } }); close_(); toast('Dismissed: ' + r); reload(); } catch (e) { close_(); toast(e.message); } }

// ============================================================ full details for a repo match (tap any result)

const safe = u => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';
const when = sec => sec ? new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

async function detail(id) {
  try {
    const d = await api(`/matches/${id}`);
    open_(`<h2>${esc(d.name)}</h2><p class="sub">${esc(d.kind)}</p>
<div class="dims"><span>Score <b>${Math.round(d.score)}</b></span><span>Significance <b>${d.sig_}</b></span><span>Fit <b>${d.res}</b></span><span>Timing <b>${d.tim}</b></span></div>
<div class="sec" style="margin-top:6px">Public signal</div><p class="sig">${esc(d.sig)}</p>
<div class="sec">Why it scored this way</div><p class="why">${esc(d.why)}</p>
${d.evidence ? `<div class="sec">Evidence</div><p class="why">${esc(d.evidence)}</p>` : ''}
${d.company ? `<div class="kv"><span>Company</span><span>${esc(d.company)}${d.people > 1 ? ` (${d.people} people)` : ''}</span></div>` : ''}
${d.topRepo ? `<div class="kv"><span>Related project</span><span>${esc(d.topRepo)}</span></div>` : ''}
${d.contact ? `<div class="kv"><span>Public contact</span><span>${esc(d.contact)}</span></div>` : ''}
<div class="acts" style="margin-top:16px"><a class="btn" href="${safe(d.url)}" target="_blank" rel="noopener noreferrer">View on GitHub</a><button class="btn ghost" onclick="close_();brief('${esc(d.id)}')">Draft outreach</button></div>`);
  } catch (e) { if (e.status === 403) { open_(`<h2>Match hidden</h2><p class="sub">Upgrade to Pro to open this match.</p><button class="btn" onclick="close_();nav('alerts')">See Pro</button>`); } else toast(e.message); }
}

// ============================================================ features (switch parts of Cleone on and off)

const FEATURES = [
  { k: 'repo', name: 'Repo scan', text: 'Scan a GitHub repo for acquirers, partners, joiners and investors.' },
  { k: 'jobs', name: 'Job Radar', text: 'Scans the web for jobs that fit you. Checks each one is still open, warns about scams and tracks your applications.' }];

function features() {
  chrome(true);
  const f = S.me.features || {};
  $('#main').innerHTML = `<button class="back" onclick="nav('${f.repo ? 'home' : 'features'}')">${I.back}Home</button><h2>Features</h2><p class="sub">Switch on what you need. Each one shows up in the side menu.</p>
${FEATURES.map(x => `<div class="card"><div class="w"><span><b>${x.name}</b><br><small style="color:var(--mute)">${x.text}</small></span><button class="sw ${f[x.k] ? 'on' : ''}" data-k="${x.k}" role="switch" aria-checked="${!!f[x.k]}" aria-label="${x.name}"></button></div></div>`).join('')}`;
  document.querySelectorAll('.sw[data-k]').forEach(b => b.onclick = async () => {
    try { S.me = await api('/me', { method: 'PATCH', body: { prefs: { features: { [b.dataset.k]: !b.classList.contains('on') } } } }); side(); features(); } catch (e) { toast(e.message); }
  });
}

// ============================================================ Job Radar

const money = n => '$' + Number(n).toLocaleString('en-US');
const badge = j => j.scamScore >= 50 ? '<span class="bd bad">Looks suspicious</span>' : j.status === 'open' ? '<span class="bd good">Confirmed open</span>' : j.status === 'closed' ? '<span class="bd bad">Closed</span>' : '<span class="bd warn">Could not verify</span>';
const jobCard = j => `<div class="card tap" role="button" tabindex="0" onclick="jobDetail('${esc(j.id)}')" onkeydown="if(event.key==='Enter')jobDetail('${esc(j.id)}')">
<div class="top"><div><div class="name">${esc(j.title)}</div><div class="kind">${esc(j.company)} &middot; ${j.remote ? 'Remote' : esc(j.location || 'On-site')}</div></div><div class="score">${j.score}</div></div>
<div style="margin:8px 0">${badge(j)}${j.boards > 1 ? `<span class="bd">On ${j.boards} boards, shown once</span>` : ''}${j.ghostFlags.length ? `<span class="bd warn">${esc(j.ghostFlags[0])}</span>` : ''}${j.salary ? `<span class="bd">${money(j.salary.min)} to ${money(j.salary.max)}</span>` : ''}</div>
<p class="why" style="margin:0">${esc(j.why[0] || j.verifyNote || '')}</p></div>`;

async function jobs() {
  if (!S.me) return auth('login');
  chrome(true);
  let pr, list;
  try { pr = await api('/jobs/profile'); } catch (e) { toast(e.message); return; }
  if (!pr.profile) return jobSetup(pr);
  try { list = await api('/jobs'); } catch (e) { toast(e.message); return; }
  S.jobs = list;
  const sec_ = (t, a) => a.length ? `<div class="sec">${t}</div>${a.map(jobCard).join('')}` : '';
  const paused = list.pausedUntil > Date.now() / 1000 ? `<div class="note">Alerts are paused until ${when(list.pausedUntil)}.</div>` : '';
  $('#main').innerHTML = `<h2>Job Radar</h2><p class="sub">Only jobs we checked are called open. If we could not check, we say so.</p>${paused}
<div class="acts" style="margin-bottom:12px"><button class="btn" id="js">Scan for jobs</button><button class="btn ghost" id="jp">Edit my profile</button></div>
<div class="bar" style="margin:0 0 14px;padding:12px 16px"><input id="jc" placeholder='Ask: "only remote now", "pause until Monday", "why did you send this?"' aria-label="Command"></div><div class="note" id="jr" style="display:none"></div>
${sec_('Confirmed open', list.open)}${sec_('Could not verify. Check the employer page first', list.unverified)}
${list.locked ? `<div class="card lock"><div class="ov" style="position:static;padding:8px"><b>${list.locked} more match${list.locked > 1 ? 'es' : ''} on Pro</b><button class="btn" onclick="nav('alerts')">Unlock with Pro</button></div></div>` : ''}
${sec_('Your applications', list.tracker)}${sec_('Closed since we told you', list.closed)}${sec_('Looks suspicious. Not recommended', list.suspicious)}
${list.open.length + list.unverified.length + list.tracker.length ? '' : '<p class="sub">No matches yet. Tap Scan for jobs.</p>'}<div id="mk"></div>`;
  $('#js').onclick = jobScan; $('#jp').onclick = () => jobSetup(pr);
  $('#jc').onkeydown = async e => { if (e.key !== 'Enter' || !e.target.value.trim()) return;
    try { const r = await api('/jobs/command', { method: 'POST', body: { text: e.target.value } }); e.target.value = ''; const n = $('#jr'); n.style.display = ''; n.textContent = r.reply; if (/remote|Now looking/.test(r.reply)) jobs(); } catch (x) { toast(x.message); } };
  try { const m = await api('/jobs/market'); if (m.openRoles) $('#mk').innerHTML = `<div class="sec">The market${m.role ? ' for ' + esc(m.role) : ''}</div><div class="card"><div class="kv"><span>Open roles we can see</span><span>${m.openRoles}</span></div>${m.medianAgeDays != null ? `<div class="kv"><span>Typical age of an open role</span><span>${m.medianAgeDays} days</span></div>` : ''}${m.salary ? `<div class="kv"><span>Stated pay (${m.salary.n} jobs)</span><span>${money(m.salary.low)} to ${money(m.salary.high)}</span></div>` : '<div class="kv"><span>Pay</span><span>Rarely stated</span></div>'}${m.hiringOften.length ? `<div class="kv"><span>Hiring often</span><span>${m.hiringOften.slice(0, 3).map(h => esc(h.company)).join(', ')}</span></div>` : ''}</div>`; } catch (e) {}
}

async function jobScan() {
  const b = $('#js'); b.disabled = true; b.textContent = 'Scanning job boards...';
  try {
    const r = await api('/jobs/scan', { method: 'POST' });
    const bad = r.sources.filter(s => !s.ok);
    toast(`${r.matched} matches. ${r.checked} pages checked.${bad.length ? ' ' + bad.length + ' source down.' : ''}`);
    S.me = await api('/me'); jobs();
  } catch (e) { b.disabled = false; b.textContent = 'Scan for jobs'; toast(e.message); }
}

function jobSetup(pr) {
  const p = (pr && pr.profile) || {};
  $('#main').innerHTML = `<h2>Your job profile</h2><p class="sub">Add your CV once. We match jobs against it and explain every match, including the gaps.</p>
<div class="field"><label for="jr_">Roles you want (comma separated)</label><input class="in" id="jr_" value="${esc(p.roles || '')}" placeholder="backend developer, python developer"></div>
<div class="field"><label for="jcv">Paste your CV (optional)</label><textarea class="in" id="jcv" rows="6" placeholder="We read the skills from it. ${pr && pr.encryption ? 'It is stored encrypted.' : 'It is not stored on this server, only the skills you confirm.'}"></textarea></div>
<div class="field"><label for="jsk">Your skills (we fill this from the CV; edit freely)</label><input class="in" id="jsk" value="${esc(p.skills || '')}"></div>
<div class="field"><label for="jy">Years of experience</label><input class="in" id="jy" type="number" min="0" max="50" value="${p.years || 0}"></div>
<div class="field"><label for="jl">Where you are</label><input class="in" id="jl" value="${esc(p.location || '')}" placeholder="Port Harcourt, Nigeria"></div>
<div class="field"><label for="jm">Minimum yearly pay in USD (optional)</label><input class="in" id="jm" type="number" min="0" value="${p.minSalary || ''}"></div>
<div class="w"><span>Remote jobs only</span><button class="sw ${p.remoteOnly ? 'on' : ''}" id="jro" role="switch" aria-checked="${!!p.remoteOnly}" aria-label="Remote only"></button></div>
<div class="err" id="er" role="alert"></div><div class="acts"><button class="btn" id="jsv">Save and find jobs</button>${p.roles || p.skills ? '<button class="btn ghost" id="jdel">Delete my profile and CV</button>' : ''}</div>`;
  $('#jro').onclick = e => e.currentTarget.classList.toggle('on');
  $('#jsv').onclick = async () => {
    try {
      const r = await api('/jobs/profile', { method: 'PUT', body: { roles: $('#jr_').value, cv: $('#jcv').value, skills: $('#jsk').value || undefined, years: +$('#jy').value, location: $('#jl').value, minSalary: +$('#jm').value, remoteOnly: $('#jro').classList.contains('on') } });
      if (r.cvNote) toast(r.cvNote); await jobs(); if (!p.roles && !p.skills) jobScan();
    } catch (e) { $('#er').textContent = e.message; }
  };
  if ($('#jdel')) $('#jdel').onclick = async () => { try { await api('/jobs/profile', { method: 'DELETE' }); toast('Profile and CV deleted'); jobSetup(null); } catch (e) { toast(e.message); } };
}

async function jobDetail(id) {
  try {
    const d = await api(`/jobs/${id}`);
    const flags = [...d.scamFlags.map(x => '&#9888; ' + esc(x)), ...d.ghostFlags.map(x => esc(x))];
    open_(`<h2>${esc(d.title)}</h2><p class="sub">${esc(d.company)} &middot; ${d.remote ? 'Remote' : esc(d.location)} ${badge(d)}</p>
<p class="sig">${esc(d.verifyNote || '')}${d.verifiedAt ? ' (checked ' + when(d.verifiedAt) + ')' : ''}</p>
${d.scamScore >= 50 ? `<div class="note" style="border:1px solid #c0392b"><b>This looks suspicious.</b> Never pay to apply. ${flags.join('. ')}</div>` : flags.length ? `<div class="note">${flags.join(' &middot; ')}</div>` : ''}
${d.likelyToCloseSoon ? `<div class="note">${esc(d.likelyToCloseSoon)}</div>` : ''}
<div class="dims"><span>Match <b>${d.score}</b></span>${d.salary ? `<span>Pay <b>${money(d.salary.min)} to ${money(d.salary.max)}</b></span>` : ''}<span>${d.companyOpenRoles} role${d.companyOpenRoles === 1 ? '' : 's'} at ${esc(d.company)}</span></div>
<div class="sec">Why it fits</div>${d.why.length ? d.why.map(w => `<p class="why" style="margin:4px 0">&#10003; ${esc(w)}</p>`).join('') : '<p class="sub">No strong reasons found.</p>'}
${d.gaps.length ? `<div class="sec">Gaps</div>${d.gaps.map(w => `<p class="why" style="margin:4px 0">&#8226; ${esc(w)}</p>`).join('')}` : ''}
<div class="sec">The job</div><div class="mail" style="max-height:220px;overflow:auto">${esc(d.description)}</div>
<div class="sec">Posted on</div>${d.boardLinks.map(b => `<a class="lnk" href="${safe(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.source)}</a> `).join('')}
<div class="acts" style="margin-top:14px"><a class="btn" href="${safe(d.applyUrl)}" target="_blank" rel="noopener noreferrer">Open employer page</a>
<button onclick="jobAct('${esc(id)}','draft')">Draft CV summary + letter</button><button onclick="jobAct('${esc(id)}','prep')">Interview prep</button><button onclick="jobAct('${esc(id)}','recheck')">Check it is still open</button></div>
<div class="acts" style="margin-top:10px"><button onclick="jobState('${esc(id)}','saved')">Save</button><button class="p" onclick="jobState('${esc(id)}','applied')">I applied</button><button onclick="jobState('${esc(id)}','replied')">Replied</button><button onclick="jobState('${esc(id)}','interview')">Interview</button><button onclick="jobState('${esc(id)}','dismissed','Not relevant')">Not relevant</button></div>
<div class="acts" style="margin-top:10px"><button onclick="jobReport('${esc(id)}','was_closed')">It was already closed</button><button onclick="jobReport('${esc(id)}','looks_scam')">Looks like a scam</button></div>
<p class="sub" style="font-size:.85rem;margin-top:12px">Cleone never applies for you. You send everything yourself.</p>`);
  } catch (e) { if (e.status === 403) open_(`<h2>Hidden on Free</h2><p class="sub">Upgrade to Pro to open every match.</p><button class="btn" onclick="close_();nav('alerts')">See Pro</button>`); else toast(e.message); }
}

async function jobAct(id, what) {
  try {
    if (what === 'recheck') { const r = await api(`/jobs/${id}/recheck`, { method: 'POST' }); toast(r.status === 'open' ? 'Still open' : r.status === 'closed' ? 'This job has closed' : 'Could not verify'); return jobDetail(id); }
    if (what === 'prep') { const r = await api(`/jobs/${id}/prep`, { method: 'POST' }); return open_(`<h2>Interview questions</h2>${r.questions.map(q => `<p class="why">&#8226; ${esc(q)}</p>`).join('')}<button class="btn ghost" onclick="jobDetail('${esc(id)}')">Back</button>`); }
    const r = await api(`/jobs/${id}/draft`, { method: 'POST' });
    open_(`<h2>Your draft</h2><p class="sub">Edit before using. Nothing was sent.</p>${r.warning ? `<div class="note">${esc(r.warning)}</div>` : ''}<div class="sec">CV summary</div><div class="mail" contenteditable="true">${esc(r.summary)}</div><div class="sec">Cover letter</div><div class="mail" contenteditable="true" id="m">${esc(r.letter)}</div>
<div class="acts"><button class="btn" id="cp">Copy letter</button><a class="btn ghost" href="${safe(r.applyUrl)}" target="_blank" rel="noopener noreferrer">Open employer page</a><button onclick="jobDetail('${esc(id)}')">Back</button></div>`);
    $('#cp').onclick = () => { try { navigator.clipboard && navigator.clipboard.writeText($('#m').innerText); } catch (e) {} toast('Copied'); };
  } catch (e) { toast(e.message); }
}
async function jobState(id, state, note) { try { const r = await api(`/jobs/${id}/state`, { method: 'POST', body: { state, note } }); close_(); toast(state === 'applied' ? 'Tracked. We will remind you in 7 days.' : 'Saved: ' + state); jobs(); } catch (e) { toast(e.message); } }
async function jobReport(id, kind) { try { await api(`/jobs/${id}/report`, { method: 'POST', body: { kind } }); close_(); toast('Thanks. This helps everyone.'); jobs(); } catch (e) { toast(e.message); } }

async function jobAlerts() {
  chrome(true);
  let r; try { r = await api('/jobs/alerts'); } catch (e) { toast(e.message); return; }
  const label = { new: 'New, checked open', closed: 'Just closed. Do not apply', followup: 'Time to follow up' };
  $('#main').innerHTML = `<button class="back" onclick="nav('jobs')">${I.back}Job Radar</button><h2>Job alerts</h2><p class="sub">We only alert on jobs we confirmed open, and tell you if one closes.${S.me.plan === 'free' ? ' Alerts are part of Pro.' : ''}</p>
${r.alerts.length ? r.alerts.map(a => `<div class="card tap" role="button" tabindex="0" onclick="jobDetail('${esc(a.job.id)}')"><div class="sig">${label[a.type]} &middot; ${when(a.at)}</div><div class="name">${esc(a.job.title)}</div><div class="kind">${esc(a.job.company)}</div></div>`).join('') : '<p class="sub">Nothing yet.</p>'}`;
}

// ============================================================ plan (the old "Weekly alerts" page)

function alerts() {
  chrome(true);
  const m = S.me, pro = m.plan === 'pro', sub = m.subscription;
  let action;
  if (pro) {
    action = `<p class="sig">You are on Pro${sub && sub.periodEnd ? (sub.status === 'cancelled' ? '. Access ends ' : '. Renews or ends around ') + fmtDate(sub.periodEnd) : ''}.</p>${sub && sub.manageable ? '<div style="margin-top:12px"><button class="btn ghost" id="mg">Manage billing</button></div>' : ''}`;
  } else if (S.cfg.payments) {
    action = '<div style="margin-top:12px"><button class="btn" id="up2">Upgrade to Pro</button></div>';
  } else {
    action = '<p class="sub" style="font-size:.9rem;margin:0 0 10px">Payments are not switched on yet. Join the waitlist and we will email you when they are.</p><input class="in" id="em" type="email" placeholder="you@startup.com" aria-label="Email"><div style="margin-top:12px"><button class="btn" id="jn">Join the waitlist</button></div>';
  }
  $('#main').innerHTML = `<button class="back" onclick="nav('home')">${I.back}Home</button><h2>Cleone Pro</h2>
<p class="sub">See every match, scan more often, and draft outreach for all of them.</p>
<div class="card"><div class="name">${esc(S.cfg.price || '')}</div><p class="why">Every match above the cutoff unlocked in all three lanes, up to ${S.cfg.plans ? S.cfg.plans.pro.scansPerMonth : 100} scans a month, outreach drafts for every match. Cancel any time.</p>${action}</div>
<p class="sub" style="font-size:.88rem">You are on the ${esc(m.planLabel)} plan. Weekly email alerts are coming soon.</p>`;
  if ($('#up2')) $('#up2').onclick = checkout;
  if ($('#mg')) $('#mg').onclick = portal;
  if ($('#jn')) $('#jn').onclick = async () => { try { await api('/waitlist', { method: 'POST', body: { email: $('#em').value } }); toast('Added to the waitlist'); } catch (e) { toast(e.message); } };
}
async function checkout() { try { const r = await api('/billing/checkout', { method: 'POST' }); location.href = r.url; } catch (e) { toast(e.message); } }
async function portal() { try { const r = await api('/billing/portal', { method: 'POST' }); location.href = r.url; } catch (e) { toast(e.message); } }

// ============================================================ settings

async function settings() {
  chrome(true);
  const m = S.me, p = m.prefs || {}, th = p.theme || 'system', sub = m.subscription;
  const pct = Math.min(100, Math.round(100 * m.usage.scans / m.usage.limit));
  $('#main').innerHTML = `<button class="back" onclick="nav('home')">${I.back}Home</button><h2>Settings</h2>
<div class="sec">Profile</div><div class="card"><div class="field"><label for="nm">Name</label><input class="in" id="nm" value="${esc(m.user.name)}" maxlength="80"></div>
<div class="kv"><span>Email</span><span>${esc(m.user.email)}</span></div><div style="margin-top:12px"><button class="btn" id="sv">Save</button></div></div>
<div class="sec">Plan and usage</div><div class="card"><div class="kv"><span>Plan</span><span>${esc(m.planLabel)}</span></div>
<div class="kv"><span>Scans this month</span><span>${m.usage.scans} of ${m.usage.limit}</span></div><div class="meter"><i style="width:${pct}%"></i></div>
${sub && sub.periodEnd ? `<div class="kv"><span>${sub.status === 'cancelled' ? 'Access ends' : 'Next payment'}</span><span>${fmtDate(sub.periodEnd)}</span></div>` : ''}
<div style="margin-top:12px">${m.plan === 'free' ? '<button class="btn" onclick="nav(\'alerts\')">Upgrade to Pro</button>' : (sub && sub.manageable ? '<button class="btn ghost" id="mg">Manage billing</button>' : '')}</div></div>
<div class="sec">Preferences</div><div class="card"><div class="seg" role="group" aria-label="Appearance">${['system', 'light', 'dark'].map(t => `<button class="${th === t ? 'on' : ''}" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
<div class="w" style="margin-top:12px"><span>Weekly email alerts<br><small style="color:var(--mute)">Coming soon. Your choice is saved.</small></span><button class="sw ${p.alerts ? 'on' : ''}" id="al" role="switch" aria-checked="${!!p.alerts}" aria-label="Weekly email alerts"></button></div></div>
<div class="sec">Outreach log</div><div class="card" id="ol"><p class="sub" style="margin:0">Loading...</p></div>
<div class="sec">Security</div><div class="card"><div class="field"><label for="cp">Current password</label><input class="in" id="cp" type="password" autocomplete="current-password"></div>
<div class="field"><label for="np">New password</label><input class="in" id="np" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
<button class="btn ghost" id="pw">Change password</button><div style="margin-top:14px"><button class="lnk" id="lo">Sign out of all devices</button></div></div>
<div class="sec">Your data</div><div class="card"><button class="lnk" id="ex">Export my data</button><br><button class="lnk danger" id="dl">Delete my account</button></div>
<div style="margin:22px 0 30px"><button class="btn ghost" onclick="logout()">Log out</button></div>`;

  $('#sv').onclick = async () => { try { S.me = await api('/me', { method: 'PATCH', body: { name: $('#nm').value } }); side(); toast('Saved'); } catch (e) { toast(e.message); } };
  document.querySelectorAll('.seg button').forEach(b => b.onclick = async () => { theme(b.dataset.t === 'system' ? null : b.dataset.t); try { S.me = await api('/me', { method: 'PATCH', body: { prefs: { theme: b.dataset.t } } }); settings(); } catch (e) { toast(e.message); } });
  $('#al').onclick = async () => { try { S.me = await api('/me', { method: 'PATCH', body: { prefs: { alerts: !(S.me.prefs || {}).alerts } } }); settings(); } catch (e) { toast(e.message); } };
  if ($('#mg')) $('#mg').onclick = portal;
  $('#pw').onclick = async () => { try { await api('/auth/password', { method: 'POST', body: { current: $('#cp').value, next: $('#np').value } }); $('#cp').value = ''; $('#np').value = ''; toast('Password changed. Other devices were signed out.'); } catch (e) { toast(e.message); } };
  $('#lo').onclick = async () => { try { await api('/auth/logout-all', { method: 'POST' }); S.me = null; auth('login'); toast('Signed out everywhere'); } catch (e) { toast(e.message); } };
  $('#ex').onclick = () => { location.href = '/api/me/export'; };
  $('#dl').onclick = deleteAccount;
  outreachLog();
}

function deleteAccount() {
  open_(`<h2>Delete your account?</h2><p class="sub">This permanently removes your account, scans, matches and outreach log. It cannot be undone.</p><div class="field"><label for="dp">Your password</label><input class="in" id="dp" type="password"></div><div class="err" id="de"></div><div class="acts"><button class="p" id="dy" style="background:#c0392b;border-color:#c0392b">Delete everything</button><button onclick="close_()">Cancel</button></div>`);
  $('#dy').onclick = async () => {
    try { await api('/me', { method: 'DELETE', body: { password: $('#dp').value } }); close_(); S.me = null; toast('Account deleted'); auth('signup'); }
    catch (e) { $('#de').textContent = e.message; }
  };
}

async function outreachLog() {
  try {
    const r = await api('/outreach');
    const el = $('#ol'); if (!el) return;
    const bands = r.bands.filter(b => b.sent).map(b => `<div class="kv"><span>Scored ${esc(b.label)}</span><span>${b.replied} of ${b.sent} replied</span></div>`).join('');
    el.innerHTML = r.items.length
      ? `<p class="sub" style="font-size:.9rem">Mark who replied. This shows how well scores predict real replies.</p>${bands}${r.items.slice(0, 20).map(o => `<div class="w"><span>${esc(o.name)}<br><small style="color:var(--mute)">${esc(o.repo)} &middot; score ${Math.round(o.score)}</small></span><button class="sw ${o.replied ? 'on' : ''}" data-id="${esc(o.id)}" role="switch" aria-checked="${!!o.replied}" aria-label="Replied"></button></div>`).join('')}`
      : '<p class="sub" style="margin:0">Drafts you copy are listed here, so you can mark who replied.</p>';
    el.querySelectorAll('.sw').forEach(b => b.onclick = async () => { try { await api(`/outreach/${b.dataset.id}/replied`, { method: 'POST', body: { replied: !b.classList.contains('on') } }); outreachLog(); } catch (e) { toast(e.message); } });
  } catch (e) {}
}

// ============================================================ start-up

$('#sheet').onclick = e => { if (e.target.id === 'sheet') close_(); };
$('#menu').onclick = () => $('#side').classList.toggle('on');
$('#upg').onclick = () => nav('alerts');

(async function boot() {
  try { const t = localStorage.getItem('cleone.theme'); if (t && t !== 'system') theme(t); } catch (e) {}
  try { S.cfg = await api('/config'); } catch (e) { $('#main').innerHTML = `<h2 style="margin-top:12vh">Cleone is unavailable</h2><p class="sub">${esc(e.message)}</p>`; return; }
  const q = new URLSearchParams(location.search);
  if (q.get('reset')) return resetScreen(q.get('reset'));
  try { S.me = await api('/me'); } catch (e) { S.me = null; }
  if (!S.me) return auth('login');
  if (q.get('reference')) {   // coming back from the payment page
    try { S.me = await api('/billing/verify?reference=' + encodeURIComponent(q.get('reference'))); toast('Welcome to Pro'); } catch (e) { toast(e.message); }
  }
  if (q.toString()) history.replaceState(null, '', location.pathname);
  await session();
  home();
})();
