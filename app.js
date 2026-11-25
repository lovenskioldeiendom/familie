import { createStore } from './data.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const TITLES = { msg: 'Beskjeder', cal: 'Kalender', fam: 'Familien' };
const COLORS = ['#6a5acd', '#e07a3f', '#2f9e7a', '#d0457a', '#3a86c8', '#b8902a', '#8b5cc4', '#4f9a3a'];
const WEEKS = 8; // hvor langt fram kalenderen viser

const S = {
  store: null, user: null, group: null, members: [], messages: [], events: [],
  tab: new URLSearchParams(location.search).get('tab') || ls.get('fa-tab', 'msg'), signUpMode: false, setupMode: 'join',
  to: 'all', // 'all' eller Set med user_id
  editing: null,
};

function show(view) {
  for (const v of ['login', 'reset', 'setup', 'main']) $('view-' + v).hidden = v !== view;
  $('tabbar').hidden = view !== 'main';
}
let toastT;
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}
const fail = (e) => toast(e?.message || String(e), 6000);

// ---------- Telefon, SMS og Hvor er? ----------
function normPhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\d{8}$/.test(s)) s = '+47' + s;
  return s;
}
const prettyPhone = (p) => {
  const n = normPhone(p);
  const m = /^\+47(\d{3})(\d{2})(\d{3})$/.exec(n);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : n;
};
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function smsUrl(numbers, body) {
  const b = encodeURIComponent(body || '');
  if (isIOS) {
    if (numbers.length > 1) return `sms://open?addresses=${numbers.join(',')}&body=${b}`;
    return `sms:${numbers[0] || ''}&body=${b}`;
  }
  return `sms:${numbers.join(',')}?body=${b}`;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
// ---------- Oppstart ----------
async function boot() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // Trykk på et varsel mens appen allerede er åpen
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open-msg' && S.group) { setTab('msg'); reloadSoon(); } });
  }
  if (/[?&]tab=/.test(location.search)) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]tab=\w+/, '').replace(/^&/, '?'));
  S.store = await createStore();
  S.store.onAuth((u) => { if (!u && S.user) { S.user = null; S.group = null; show('login'); } });
  S.store.onRecovery(() => show('reset'));
  S.user = await S.store.user();
  if (S.store.isRecovering()) return show('reset');
  if (!S.user) return show('login');
  await afterLogin();
}

async function afterLogin() {
  try { S.group = await S.store.group(); } catch (e) { fail(e); }
  if (!S.group) {
    $('setup-name').value = ls.get('fa-name', '');
    $('setup-phone').value = ls.get('fa-phone', '');
    return show('setup');
  }
  show('main');
  setTab(S.tab);
  S.store.subscribe(S.group.id, (t) => reloadSoon(t), (st) => {
    $('sync').classList.toggle('off', st !== 'SUBSCRIBED');
    if (st === 'SUBSCRIBED') reloadSoon();
  });
  await reload();
  refreshPush();
}

// ---------- Innlogging ----------
$('login-toggle').onclick = () => {
  S.signUpMode = !S.signUpMode;
  $('login-submit').textContent = S.signUpMode ? 'Lag konto' : 'Logg inn';
  $('login-toggle').textContent = S.signUpMode ? 'Har konto? Logg inn' : 'Ny bruker? Lag konto';
  $('login-password').autocomplete = S.signUpMode ? 'new-password' : 'current-password';
};
$('login-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('login-error'); err.hidden = true; err.className = 'error';
  const email = $('login-email').value.trim(), pw = $('login-password').value;
  $('login-submit').disabled = true;
  try {
    if (S.signUpMode) {
      const r = await S.store.signUp(email, pw);
      if (r.needsConfirm) {
        err.textContent = 'Sjekk e-posten din og trykk på lenken for å bekrefte. Kom så tilbake hit og logg inn.';
        err.hidden = false; return;
      }
    } else await S.store.signIn(email, pw);
    S.user = await S.store.user();
    await afterLogin();
  } catch (x) { err.textContent = x.message; err.hidden = false; }
  finally { $('login-submit').disabled = false; }
};

// ---------- Glemt passord ----------
$('login-forgot').onclick = async () => {
  const err = $('login-error'); err.hidden = true; err.className = 'error';
  const email = $('login-email').value.trim();
  if (!email || !$('login-email').checkValidity()) {
    err.textContent = 'Skriv inn e-posten din øverst, og trykk «Glemt passord?» igjen.';
    err.hidden = false; $('login-email').focus(); return;
  }
  $('login-forgot').disabled = true;
  try {
    await S.store.resetPassword(email);
    err.className = 'hint';
    err.textContent = `Vi har sendt en e-post til ${email}. Trykk på lenken i e-posten for å lage nytt passord. Sjekk søppelpost hvis den ikke kommer.`;
  } catch (x) { err.textContent = x.message; }
  err.hidden = false;
  $('login-forgot').disabled = false;
};
$('reset-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('reset-error'); err.hidden = true;
  $('reset-submit').disabled = true;
  try {
    await S.store.setNewPassword($('reset-password').value);
    toast('Nytt passord er lagret');
    S.user = await S.store.user();
    if (S.user) await afterLogin(); else show('login');
  } catch (x) { err.textContent = x.message; err.hidden = false; }
  finally { $('reset-submit').disabled = false; }
};

// ---------- Oppsett ----------
document.querySelectorAll('.seg-btn').forEach((b) => b.onclick = () => {
  S.setupMode = b.dataset.mode;
  document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  $('setup-hh-wrap').hidden = S.setupMode !== 'new';
  $('setup-code-wrap').hidden = S.setupMode !== 'join';
  $('setup-code').required = S.setupMode === 'join';
  $('setup-submit').textContent = S.setupMode === 'new' ? 'Lag familie' : 'Bli med';
});
$('setup-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('setup-error'); err.hidden = true;
  const name = $('setup-name').value.trim(), phone = normPhone($('setup-phone').value);
  ls.set('fa-name', name); ls.set('fa-phone', phone);
  $('setup-submit').disabled = true;
  try {
    S.group = S.setupMode === 'new'
      ? await S.store.createGroup($('setup-hh').value.trim(), name, phone)
      : await S.store.joinGroup($('setup-code').value.trim(), name, phone);
    await afterLogin();
  } catch (x) { err.textContent = x.message; err.hidden = false; }
  finally { $('setup-submit').disabled = false; }
};
$('setup-logout').onclick = () => logout();
async function logout() {
  // Ikke send flere varsler til denne telefonen for denne brukeren
  try { const sub = await pushSub(); if (sub) await S.store.deletePush(sub.endpoint); } catch {}
  S.pushSaved = false;
  await S.store.signOut().catch(() => {});
  S.user = null; S.group = null; S.messages = []; S.events = []; S.members = [];
  show('login');
}

// ---------- Faner ----------
document.querySelectorAll('.tab').forEach((b) => b.onclick = () => setTab(b.dataset.tab));
function setTab(tab) {
  if (!TITLES[tab]) tab = 'msg';
  S.tab = tab; ls.set('fa-tab', tab);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('title').textContent = tab === 'fam' && S.group ? S.group.name : TITLES[tab];
  for (const p of ['msg', 'cal', 'fam']) $('pane-' + p).hidden = p !== tab;
  render();
  window.scrollTo(0, 0);
}

// ---------- Lasting ----------
let reloadT;
function reloadSoon() { clearTimeout(reloadT); reloadT = setTimeout(reload, 250); }
async function reload() {
  if (!S.group) return;
  try {
    const [m, msgs, evs] = await Promise.all([
      S.store.members(S.group.id), S.store.messages(S.group.id), S.store.events(S.group.id),
    ]);
    S.members = m; S.messages = msgs; S.events = evs;
    if (!S.members.some((x) => x.user_id === S.user.id)) { S.group = null; return afterLogin(); }
    render();
  } catch (e) { fail(e); }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.group) { reloadSoon(); clearNotifications(); } });
setInterval(() => { if (!document.hidden && S.group) reload(); }, 60e3);

const member = (uid) => S.members.find((m) => m.user_id === uid);
const nameOf = (uid) => (uid === S.user?.id ? 'Deg' : member(uid)?.display_name || 'Tidligere medlem');
const colorOf = (uid) => {
  const m = member(uid); if (m?.color) return m.color;
  const i = S.members.findIndex((x) => x.user_id === uid);
  return COLORS[(i < 0 ? 0 : i) % COLORS.length];
};
const avatar = (uid, size = '') => {
  const n = member(uid)?.display_name || '?';
  return `<span class="avatar ${size}" style="background:${colorOf(uid)}">${esc(n.trim().charAt(0).toUpperCase() || '?')}</span>`;
};
const others = () => S.members.filter((m) => m.user_id !== S.user.id);

function render() {
  renderBadge();
  if (S.tab === 'msg') renderMessages();
  else if (S.tab === 'cal') renderCal();
  else renderFamily();
}

// ---------- Beskjeder ----------
function renderBadge() {
  const seen = ls.get('fa-seen', '');
  if (S.tab === 'msg' && !document.hidden && S.messages[0]) ls.set('fa-seen', S.messages[0].created_at);
  const n = S.tab === 'msg' ? 0 : S.messages.filter((m) => m.sender !== S.user?.id && m.created_at > seen).length;
  $('badge-msg').textContent = n || '';
}

function renderTo() {
  const all = S.to === 'all';
  $('msg-to').innerHTML = `<button type="button" class="chip${all ? ' on' : ''}" data-uid="all">Alle</button>`
    + others().map((m) => `<button type="button" class="chip${!all && S.to.has(m.user_id) ? ' on' : ''}" data-uid="${m.user_id}">${esc(m.display_name)}</button>`).join('');
  updateSmsHint();
}
$('msg-to').onclick = (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  const uid = c.dataset.uid;
  if (uid === 'all') S.to = 'all';
  else {
    if (S.to === 'all') S.to = new Set();
    S.to.has(uid) ? S.to.delete(uid) : S.to.add(uid);
    if (!S.to.size) S.to = 'all';
  }
  renderTo();
};
function recipientsNow() { return S.to === 'all' ? others() : others().filter((m) => S.to.has(m.user_id)); }
function updateSmsHint() {
  const h = $('msg-sms-hint');
  if (!$('msg-sms').checked) { h.hidden = true; return; }
  const rec = recipientsNow();
  const missing = rec.filter((m) => !normPhone(m.phone));
  h.textContent = !rec.length ? 'Det er ingen andre i familien ennå.'
    : 'Meldingsappen åpnes med mottakere og tekst ferdig utfylt. Trykk send der.'
      + (missing.length ? ` ${missing.map((m) => m.display_name).join(', ')} mangler mobilnummer og får bare beskjeden i appen.` : '');
  h.hidden = false;
}
$('msg-sms').checked = ls.get('fa-sms', false);
$('msg-sms').onchange = () => { ls.set('fa-sms', $('msg-sms').checked); updateSmsHint(); };
const autoGrow = () => { const t = $('msg-body'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 240) + 'px'; };
$('msg-body').addEventListener('input', autoGrow);

$('msg-form').onsubmit = async (e) => {
  e.preventDefault();
  const body = $('msg-body').value.trim(); if (!body) return;
  const toAll = S.to === 'all';
  const rec = recipientsNow();
  const wantSms = $('msg-sms').checked;
  $('msg-send').disabled = true;
  try {
    const sent = await S.store.sendMessage(S.group.id, body, toAll, toAll ? [] : rec.map((m) => m.user_id));
    const notified = sent?.id ? S.store.notify(sent.id).catch((x) => console.log('varsel', x)) : null;
    $('msg-body').value = ''; autoGrow();
    S.to = 'all';
    await reload();
    if (wantSms) {
      const nums = rec.map((m) => normPhone(m.phone)).filter(Boolean);
      if (nums.length) {
        await Promise.race([notified, new Promise((r) => setTimeout(r, 2500))]); // la varslene gå før meldingsappen åpnes
        location.href = smsUrl(nums, body);
      }
      else toast('Ingen av mottakerne har mobilnummer, så det ble bare sendt i appen.');
    } else toast('Sendt');
  } catch (x) { fail(x); }
  finally { $('msg-send').disabled = false; }
};

function when(iso) {
  const d = new Date(iso), now = new Date();
  const t = d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'i dag ' + t;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'i går ' + t;
  return d.toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + t;
}
function renderMessages() {
  renderTo();
  const list = S.messages;
  $('msgs-empty').hidden = list.length > 0;
  $('msgs').innerHTML = list.map((m) => {
    const mine = m.sender === S.user.id;
    const acks = (m.fa_acks || []).map((a) => a.user_id);
    const iAck = acks.includes(S.user.id);
    const to = m.to_all ? 'til alle' : 'til ' + m.recipients.map((u) => (u === S.user.id ? 'deg' : nameOf(u))).join(', ');
    const ackNames = acks.filter((u) => u !== S.user.id).map(nameOf);
    return `<li class="msg card${mine ? ' mine' : ''}" data-id="${m.id}">
      <div class="msg-head">${avatar(m.sender)}<span><b>${mine ? 'Du' : esc(nameOf(m.sender))}</b> <span class="muted">${esc(to)}</span><small>${esc(when(m.created_at))}</small></span>
        ${mine ? '<button class="del" aria-label="Slett beskjed">✕</button>' : ''}</div>
      <p class="msg-body">${esc(m.body)}</p>
      <div class="msg-foot">
        ${mine ? '' : `<button class="ack${iAck ? ' on' : ''}">👍 ${iAck ? 'Sett' : 'Ok'}</button>`}
        ${ackNames.length ? `<span class="muted small">👍 ${esc(ackNames.join(', '))}</span>` : (mine ? '<span class="muted small">Ingen har svart ennå</span>' : '')}
      </div>
    </li>`;
  }).join('');
}
$('msgs').onclick = async (e) => {
  const li = e.target.closest('.msg'); if (!li) return;
  const m = S.messages.find((x) => x.id === li.dataset.id); if (!m) return;
  if (e.target.closest('.del')) {
    if (!confirm('Slette beskjeden for alle?')) return;
    S.messages = S.messages.filter((x) => x !== m); render();
    S.store.deleteMessage(m.id).catch((x) => { fail(x); reload(); });
  } else if (e.target.closest('.ack')) {
    const on = !(m.fa_acks || []).some((a) => a.user_id === S.user.id);
    m.fa_acks = (m.fa_acks || []).filter((a) => a.user_id !== S.user.id);
    if (on) m.fa_acks.push({ user_id: S.user.id });
    render();
    S.store.ack(m.id, on).catch((x) => { fail(x); reload(); });
  }
};

// ---------- Varsler (push) ----------
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function pushSupport() {
  if (S.store?.demo) return 'demo';
  if (isIOS && !isStandalone()) return 'ios-browser';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) || location.protocol !== 'https:') return 'unsupported';
  return 'ok';
}
async function swReg() {
  return Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Appen er ikke klar ennå. Lukk den helt og åpne den igjen.')), 8000))]);
}
async function pushSub() {
  if (pushSupport() !== 'ok') return null;
  return (await swReg()).pushManager.getSubscription();
}
function b64ToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function subscribePush() {
  const reg = await swReg();
  const key = b64ToBytes(await S.store.pushKey());
  let sub = await reg.pushManager.getSubscription();
  const same = sub?.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).every((x, i) => x === key[i]);
  if (sub && !same) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await S.store.savePush(sub);
  S.pushSaved = true;
  return sub;
}
// Ved oppstart: sørg for at denne telefonen er koblet til den som er logget inn.
async function refreshPush() {
  S.pushOn = false;
  try {
    if (pushSupport() === 'ok' && Notification.permission === 'granted') {
      const sub = await pushSub();
      if (sub && !S.pushSaved) { await S.store.savePush(sub); S.pushSaved = true; }
      else if (!sub) await subscribePush();
      S.pushOn = true;
    }
  } catch (e) { console.log('varsler', e); }
  renderPush();
  clearNotifications();
}
function renderPush() {
  const sup = pushSupport();
  const perm = sup === 'ok' ? Notification.permission : '';
  const st = $('push-status'), tog = $('push-toggle'), test = $('push-test');
  tog.hidden = test.hidden = true;
  if (sup === 'demo') st.textContent = 'Varsler virker ikke i demomodus.';
  else if (sup === 'ios-browser') st.textContent = 'For å få varsler på iPhone må appen åpnes fra hjemskjermen. Trykk Del-knappen i Safari og velg «Legg til på Hjem-skjerm», og åpne den derfra.';
  else if (sup === 'unsupported') st.textContent = 'Denne telefonen eller nettleseren støtter ikke varsler. På iPhone trengs iOS 16.4 eller nyere.';
  else if (perm === 'denied') st.textContent = 'Varsler er slått av for appen. Gå til Innstillinger → Varslinger → Familien på telefonen og slå på «Tillat varslinger». Åpne så appen igjen.';
  else if (S.pushOn) {
    st.textContent = '🔔 Varsler er på. Du får varsel når noen sender en beskjed til deg eller til alle.';
    tog.hidden = false; tog.textContent = 'Slå av varsler'; tog.className = 'btn ghost danger';
    test.hidden = false;
  } else {
    st.textContent = 'Få varsel på telefonen når det kommer nye beskjeder, også når appen er lukket.';
    tog.hidden = false; tog.textContent = 'Slå på varsler'; tog.className = 'btn primary';
  }
  $('push-banner').hidden = !(sup === 'ok' && perm !== 'denied' && !S.pushOn && !ls.get('fa-push-x', false));
}
async function enablePush(btn) {
  if (pushSupport() !== 'ok') { renderPush(); setTab('fam'); return; }
  btn.disabled = true;
  try {
    // Spør om lov med en gang (iPhone krever at det skjer rett etter trykket)
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderPush(); toast(perm === 'denied' ? 'Du sa nei til varsler. Det kan endres i Innstillinger på telefonen.' : 'Varsler ble ikke slått på.', 6000); return; }
    await subscribePush();
    S.pushOn = true; renderPush();
    toast('Varsler er på 🔔');
    S.store.testPush().catch(() => {});
  } catch (e) { fail(e); }
  finally { btn.disabled = false; }
}
async function disablePush() {
  try {
    const sub = await pushSub();
    if (sub) { await S.store.deletePush(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
    S.pushOn = false; S.pushSaved = false; renderPush();
    toast('Varsler er slått av');
  } catch (e) { fail(e); }
}
$('push-toggle').onclick = (e) => (S.pushOn ? disablePush() : enablePush(e.currentTarget));
$('push-banner-on').onclick = (e) => enablePush(e.currentTarget);
$('push-banner-x').onclick = () => { ls.set('fa-push-x', true); renderPush(); toast('Du kan slå på varsler senere under Familien.'); };
$('push-test').onclick = async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const r = await S.store.testPush();
    toast(r?.sent ? 'Prøvevarsel sendt. Det kommer om noen sekunder.' : 'Fant ingen telefon å sende til. Slå varsler av og på igjen.', 5000);
  } catch (x) { fail(x); }
  finally { b.disabled = false; }
};
async function clearNotifications() {
  try {
    if (S.tab !== 'msg' || pushSupport() !== 'ok') return;
    for (const n of await (await swReg()).getNotifications()) n.close();
  } catch {}
}

// ---------- Kalender ----------
const dayKey = (d) => d.toLocaleDateString('sv-SE');
const parseDay = (k) => new Date(k + 'T12:00:00');
const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };
const hm = (t) => (t ? t.slice(0, 5) : '');
function dayLabel(key) {
  const t = dayKey(new Date());
  if (key === t) return 'I dag';
  if (key === addDays(t, 1)) return 'I morgen';
  const s = parseDay(key).toLocaleDateString('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function occurrences() {
  const from = dayKey(new Date()), to = addDays(from, WEEKS * 7);
  const out = [];
  for (const ev of S.events) {
    if (ev.repeat === 'weekly') {
      let k = ev.date;
      if (k < from) { const weeks = Math.floor((parseDay(from) - parseDay(k)) / (7 * 864e5)); k = addDays(k, weeks * 7); }
      for (; k <= to && (!ev.until || k <= ev.until); k = addDays(k, 7)) if (k >= from) out.push({ ev, day: k });
    } else if (ev.date >= from && ev.date <= to) out.push({ ev, day: ev.date });
  }
  return out.sort((a, b) => (a.day + (a.ev.start_time || '')).localeCompare(b.day + (b.ev.start_time || '')));
}
function renderCal() {
  const box = $('cal');
  const occ = occurrences();
  if (!occ.length) { box.innerHTML = '<p class="empty">Ingen avtaler de neste ukene. Trykk «+ Ny avtale» for å legge inn fotballtrening, bursdager og annet.</p>'; return; }
  const days = new Map();
  for (const o of occ) { if (!days.has(o.day)) days.set(o.day, []); days.get(o.day).push(o); }
  const today = dayKey(new Date());
  box.innerHTML = [...days].map(([k, list]) => `<h4 class="cal-day${k === today ? ' today' : ''}">${esc(dayLabel(k))}</h4>
    <ul class="cal-list card">${list.map(({ ev, day }) => {
      const driver = (ev.drivers || {})[day];
      const time = ev.start_time ? hm(ev.start_time) + (ev.end_time ? '–' + hm(ev.end_time) : '') : 'Hele dagen';
      return `<li data-id="${ev.id}" data-day="${day}">
        <span class="cal-time">${esc(time)}</span>
        <span class="cal-title">${esc(ev.title)}${ev.repeat === 'weekly' ? ' <span class="muted" title="Hver uke">↻</span>' : ''}
          ${ev.location ? `<small>📍 ${esc(ev.location)}</small>` : ''}
          ${ev.who?.length ? `<small class="who">${ev.who.map((u) => avatar(u, 'xs') + esc(member(u)?.display_name || '')).join(' ')}</small>` : ''}
          <button class="drive${driver ? ' on' : ''}">🚗 ${driver ? (driver === S.user.id ? 'Du kjører' : esc(nameOf(driver)) + ' kjører') : 'Hvem kjører?'}</button>
        </span>
      </li>`;
    }).join('')}</ul>`).join('');
}
$('cal').onclick = async (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const ev = S.events.find((x) => x.id === li.dataset.id); if (!ev) return;
  if (e.target.closest('.drive')) {
    const day = li.dataset.day;
    const drivers = { ...(ev.drivers || {}) };
    if (drivers[day] === S.user.id) delete drivers[day];
    else if (drivers[day] && !confirm(`${nameOf(drivers[day])} har sagt de kjører. Vil du ta over?`)) return;
    else drivers[day] = S.user.id;
    // rydd bort gamle datoer
    const today = dayKey(new Date());
    for (const k of Object.keys(drivers)) if (k < today) delete drivers[k];
    ev.drivers = drivers; render();
    S.store.setDrivers(ev.id, drivers).catch((x) => { fail(x); reload(); });
    return;
  }
  openEvent(ev);
};

function renderWho(sel) {
  $('ev-who').innerHTML = S.members.map((m) => `<button type="button" class="chip${sel.has(m.user_id) ? ' on' : ''}" data-uid="${m.user_id}">${esc(m.display_name)}</button>`).join('');
}
let evWho = new Set();
$('ev-who').onclick = (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  evWho.has(c.dataset.uid) ? evWho.delete(c.dataset.uid) : evWho.add(c.dataset.uid);
  renderWho(evWho);
};
function openEvent(ev) {
  S.editing = ev || null;
  $('event-form').reset();
  $('ev-head').textContent = ev ? 'Endre avtale' : 'Ny avtale';
  $('ev-title').value = ev?.title || '';
  $('ev-date').value = ev?.date || dayKey(new Date());
  $('ev-allday').checked = ev ? !ev.start_time : false;
  $('ev-from').value = hm(ev?.start_time) || '17:00';
  $('ev-to').value = hm(ev?.end_time) || '18:00';
  $('ev-weekly').checked = ev?.repeat === 'weekly';
  $('ev-until').value = ev?.until || '';
  $('ev-loc').value = ev?.location || '';
  evWho = new Set(ev?.who || []);
  renderWho(evWho);
  $('ev-times').hidden = $('ev-allday').checked;
  $('ev-until-wrap').hidden = !$('ev-weekly').checked;
  $('ev-delete').hidden = !ev;
  $('ev-tell').hidden = !ev;
  $('event-dlg').showModal();
  if (!ev) setTimeout(() => $('ev-title').focus(), 50);
}
$('new-event').onclick = () => openEvent(null);
$('ev-allday').onchange = () => { $('ev-times').hidden = $('ev-allday').checked; };
$('ev-weekly').onchange = () => { $('ev-until-wrap').hidden = !$('ev-weekly').checked; };
$('ev-from').onchange = () => {
  const [h, m] = $('ev-from').value.split(':').map(Number);
  if (!isNaN(h)) $('ev-to').value = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
$('event-form').onsubmit = async (e) => {
  e.preventDefault();
  const allDay = $('ev-allday').checked, weekly = $('ev-weekly').checked;
  const ev = {
    title: $('ev-title').value.trim(),
    date: $('ev-date').value,
    start_time: allDay ? null : ($('ev-from').value || null),
    end_time: allDay ? null : ($('ev-to').value || null),
    repeat: weekly ? 'weekly' : 'none',
    until: weekly && $('ev-until').value ? $('ev-until').value : null,
    location: $('ev-loc').value.trim() || null,
    who: [...evWho],
  };
  if (S.editing) ev.id = S.editing.id;
  try {
    await S.store.saveEvent(S.group.id, ev);
    $('event-dlg').close();
    toast(S.editing ? 'Avtalen er endret' : 'Avtalen er lagt inn');
    await reload();
  } catch (x) { fail(x); }
};
$('ev-delete').onclick = async () => {
  const ev = S.editing; if (!ev) return;
  if (!confirm(ev.repeat === 'weekly' ? 'Slette alle gangene av denne avtalen?' : 'Slette avtalen?')) return;
  try { await S.store.deleteEvent(ev.id); $('event-dlg').close(); await reload(); } catch (x) { fail(x); }
};
$('ev-tell').onclick = () => {
  const ev = S.editing; if (!ev) return;
  const next = occurrences().find((o) => o.ev.id === ev.id)?.day || ev.date;
  const time = ev.start_time ? ' kl ' + hm(ev.start_time) : '';
  $('event-dlg').close();
  setTab('msg');
  $('msg-body').value = `${ev.title} ${dayLabel(next).toLowerCase()}${time}${ev.location ? ' (' + ev.location + ')' : ''}.`;
  autoGrow();
  const rec = (ev.who || []).filter((u) => u !== S.user.id && member(u));
  S.to = rec.length ? new Set(rec) : 'all';
  renderTo();
  $('msg-body').focus();
};

// ---------- Familien ----------
function renderFamily() {
  $('title').textContent = S.group?.name || 'Familien';
  $('fam-name').textContent = S.group?.name || '';
  $('fam-code').textContent = S.group?.invite_code || '';
  const me = member(S.user.id);
  if (document.activeElement?.closest?.('#me-form') == null) {
    $('me-name').value = me?.display_name || '';
    $('me-phone').value = me?.phone ? prettyPhone(me.phone) : '';
  }
  $('me-email').textContent = S.user?.email || '';
  $('members').innerHTML = S.members.map((m) => {
    const isMe = m.user_id === S.user.id;
    const ph = normPhone(m.phone);
    return `<li data-uid="${m.user_id}">
      ${avatar(m.user_id, 'lg')}
      <span class="mem-name"><b>${esc(m.display_name || '(uten navn)')}${isMe ? ' <span class="muted">(deg)</span>' : ''}</b>
        <small>${ph ? esc(prettyPhone(ph)) : 'Ikke lagt inn mobilnummer'}</small></span>
      ${!isMe && ph ? `<span class="mem-btns">
        <a class="round" href="tel:${esc(ph)}" aria-label="Ring">📞</a>
        <a class="round" href="${esc(smsUrl([ph], ''))}" aria-label="SMS">💬</a>
        ${isIOS ? '<a class="round findmy" href="findmy://">Hvor er?</a>' : ''}
      </span>` : ''}
    </li>`;
  }).join('');
}
$('me-form').onsubmit = async (e) => {
  e.preventDefault();
  const fields = { display_name: $('me-name').value.trim(), phone: normPhone($('me-phone').value) || null };
  try {
    await S.store.updateMe(S.group.id, S.user.id, fields);
    ls.set('fa-name', fields.display_name); ls.set('fa-phone', fields.phone || '');
    document.activeElement?.blur();
    toast('Lagret');
    await reload();
  } catch (x) { fail(x); }
};
$('share-code').onclick = async () => {
  const text = `Bli med i familieappen vår «${S.group.name}»! Åpne ${location.origin + location.pathname}, lag konto, og skriv inn koden: ${S.group.invite_code}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else if (await copy(text)) toast('Invitasjonen er kopiert. Lim den inn i en melding.');
    else toast(text, 10000);
  } catch {}
};
$('logout').onclick = () => logout();

boot().catch((e) => {
  show('login');
  $('login-error').textContent = 'Fikk ikke startet appen. Sjekk nettforbindelsen og åpne appen på nytt. (' + (e?.message || e) + ')';
  $('login-error').hidden = false;
});
