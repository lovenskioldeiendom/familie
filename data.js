// Datalag: Supabase når nøkkel finnes, ellers lokal lagring (demomodus: legg ?demo bak adressen).
import { CONFIG } from './config.js';

export async function createStore() {
  if (CONFIG.SUPABASE_ANON_KEY && !/[?&]demo\b/.test(location.search)) return createSupabaseStore();
  return createLocalStore();
}

async function createSupabaseStore() {
  // Kom brukeren hit fra «Glemt passord»-lenken i e-posten? (sjekkes før Supabase rydder adressen)
  let recovering = /type=recovery/.test(location.hash);
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'familie-auth' },
  });
  const check = ({ data, error }) => { if (error) throw new Error(norskFeil(error.message)); return data; };
  let channel = null;
  // Kom brukeren hit fra «Glemt passord»-lenken i e-posten?
  const recoveryCbs = [];
  sb.auth.onAuthStateChange((e) => { if (e === 'PASSWORD_RECOVERY') { recovering = true; recoveryCbs.forEach((f) => f()); } });

  return {
    demo: false,
    isRecovering() { return recovering; },
    onRecovery(cb) { recoveryCbs.push(cb); },
    async resetPassword(email) {
      check(await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
    },
    async setNewPassword(password) {
      check(await sb.auth.updateUser({ password }));
      recovering = false;
      history.replaceState(null, '', location.pathname + location.search);
    },
    async user() { const { data } = await sb.auth.getSession(); return data.session?.user ?? null; },
    onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s?.user ?? null)); },
    async signIn(email, password) { check(await sb.auth.signInWithPassword({ email, password })); },
    async signUp(email, password) {
      const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }));
      return { needsConfirm: !data.session };
    },
    async signOut() { await sb.auth.signOut(); },

    async group() {
      const rows = check(await sb.from('fa_groups').select('*').order('created_at').limit(1));
      return rows[0] ?? null;
    },
    async members(gid) { return check(await sb.from('fa_members').select('*').eq('group_id', gid).order('joined_at')); },
    async createGroup(name, display, phone) { return check(await sb.rpc('fa_create_group', { p_name: name, p_display: display, p_phone: phone })); },
    async joinGroup(code, display, phone) { return check(await sb.rpc('fa_join_group', { p_code: code, p_display: display, p_phone: phone })); },
    async updateMe(gid, uid, fields) { check(await sb.from('fa_members').update(fields).eq('group_id', gid).eq('user_id', uid)); },
    async leave(gid, uid) { check(await sb.from('fa_members').delete().eq('group_id', gid).eq('user_id', uid)); },

    async messages(gid) {
      return check(await sb.from('fa_messages').select('*, fa_acks(user_id)').eq('group_id', gid)
        .order('created_at', { ascending: false }).limit(200));
    },
    async sendMessage(gid, body, toAll, recipients) {
      return check(await sb.from('fa_messages').insert({ group_id: gid, body, to_all: toAll, recipients }).select().single());
    },
    async deleteMessage(id) { check(await sb.from('fa_messages').delete().eq('id', id)); },
    async ack(id, on) {
      if (on) check(await sb.from('fa_acks').upsert({ message_id: id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true }));
      else { const u = await this.user(); check(await sb.from('fa_acks').delete().eq('message_id', id).eq('user_id', u.id)); }
    },

    async events(gid) { return check(await sb.from('fa_events').select('*').eq('group_id', gid).order('date')); },
    async saveEvent(gid, ev) {
      const row = { ...ev, group_id: gid }; delete row.id;
      if (ev.id) return check(await sb.from('fa_events').update(row).eq('id', ev.id).select().single());
      return check(await sb.from('fa_events').insert(row).select().single());
    },
    async setDrivers(id, drivers) { check(await sb.from('fa_events').update({ drivers }).eq('id', id)); },
    async deleteEvent(id) { check(await sb.from('fa_events').delete().eq('id', id)); },

    // ---------- Varsler ----------
    async pushCall(body) {
      const { data, error } = await sb.functions.invoke('familie-varsel', { body });
      if (error) {
        let msg = '';
        try { msg = (await error.context.json()).error || ''; } catch {}
        if (!msg && (error.context?.status === 404 || /Failed to send a request/i.test(error.message))) msg = 'Varsler er ikke satt opp ennå (funksjonen familie-varsel mangler i Supabase).';
        throw new Error(norskFeil(msg || error.message));
      }
      return data;
    },
    async pushKey() { return (await this.pushCall({ action: 'key' })).publicKey; },
    async savePush(sub) {
      const j = sub.toJSON();
      check(await sb.rpc('fa_save_push', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth }));
    },
    async deletePush(endpoint) { check(await sb.rpc('fa_delete_push', { p_endpoint: endpoint })); },
    async notify(messageId) { return this.pushCall({ action: 'send', message_id: messageId }); },
    async testPush() { return this.pushCall({ action: 'test' }); },

    // Sanntid: kaller cb(tabell) når noe endres
    subscribe(gid, cb, onStatus) {
      if (channel) sb.removeChannel(channel);
      channel = sb.channel('fa-' + gid);
      for (const t of ['fa_messages', 'fa_acks', 'fa_events', 'fa_members']) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => cb(t));
      }
      channel.subscribe((status) => onStatus?.(status));
    },
  };
}

function norskFeil(msg) {
  if (/Invalid login credentials/i.test(msg)) return 'Feil e-post eller passord.';
  if (/Email not confirmed/i.test(msg)) return 'E-posten er ikke bekreftet ennå. Sjekk innboksen.';
  if (/already registered/i.test(msg)) return 'Det finnes allerede en konto med denne e-posten. Trykk «Har konto? Logg inn».';
  if (/should be different from the old/i.test(msg)) return 'Det nye passordet må være forskjellig fra det gamle.';
  if (/Auth session missing|expired|invalid.*(token|link)/i.test(msg)) return 'Lenken er for gammel eller allerede brukt. Trykk «Glemt passord?» og be om en ny.';
  if (/Password should be/i.test(msg)) return 'Passordet må ha minst 6 tegn.';
  if (/email rate limit/i.test(msg)) return 'Appen har sendt for mange e-poster den siste timen (gjelder alle i familien til sammen). Prøv igjen om en time, eller be den som satte opp appen slå av e-postbekreftelse i Supabase.';
  if (/rate limit/i.test(msg)) return 'For mange forsøk på kort tid. Vent et minutt og prøv igjen.';
  if (/Ukjent kode/i.test(msg)) return 'Fant ingen familie med den koden. Sjekk at den er skrevet riktig.';
  if (/permission denied/i.test(msg)) return 'Databasen mangler tilgang. Kjør supabase.sql i Supabase (SQL Editor).';
  if (/row-level security/i.test(msg)) return 'Databasen avviste endringen. Logg ut og inn igjen.';
  if (/relation .* does not exist|Could not find the (table|function)/i.test(msg)) return 'Databasen er ikke satt opp ennå (kjør supabase.sql i Supabase).';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Ingen nettforbindelse. Prøv igjen.';
  return msg;
}

// Demomodus: alt lagres i nettleseren på denne enheten, med noen påfunne familiemedlemmer.
function createLocalStore() {
  const K = 'familie-demo';
  const load = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch { return {}; } };
  const db = Object.assign({ group: null, members: [], messages: [], events: [] }, load());
  const save = () => { try { localStorage.setItem(K, JSON.stringify(db)); } catch {} };
  let cb = null; const fire = (t) => cb?.(t);
  const me = { id: 'demo-me', email: 'demo (lagres bare her)' };
  const seed = (name, phone) => {
    db.group = { id: 'demo', name: name || 'Familien', invite_code: 'DEMO00' };
    db.members = [
      { group_id: 'demo', user_id: me.id, display_name: db.myName || 'Meg', phone, joined_at: '2026-01-01' },
      { group_id: 'demo', user_id: 'demo-2', display_name: 'Mamma', phone: '+4790000001', joined_at: '2026-01-02' },
      { group_id: 'demo', user_id: 'demo-3', display_name: 'Iris', phone: '+4790000002', joined_at: '2026-01-03' },
      { group_id: 'demo', user_id: 'demo-4', display_name: 'Ola', phone: '', joined_at: '2026-01-04' },
    ];
    const today = new Date().toLocaleDateString('sv-SE');
    const tue = new Date(); tue.setDate(tue.getDate() + ((2 - tue.getDay() + 7) % 7));
    db.events = [
      { id: 'e1', group_id: 'demo', title: 'Fotballtrening', date: tue.toLocaleDateString('sv-SE'), start_time: '17:00', end_time: '18:15', repeat: 'weekly', until: null, location: 'Kunstgresset', who: ['demo-3'], drivers: {}, created_by: 'demo-2' },
      { id: 'e2', group_id: 'demo', title: 'Foreldremøte', date: today, start_time: '19:00', end_time: '20:00', repeat: 'none', until: null, location: 'Skolen', who: [], drivers: {}, created_by: me.id },
    ];
    db.messages = [
      { id: 'm1', group_id: 'demo', sender: 'demo-2', body: 'Middag kl 17 i dag. Husk å ta med gymtøy hjem!', to_all: true, recipients: [], created_at: new Date(Date.now() - 3600e3).toISOString(), fa_acks: [{ user_id: 'demo-3' }] },
    ];
  };
  return {
    demo: true,
    isRecovering() { return false; }, onRecovery() {}, async resetPassword() {}, async setNewPassword() {},
    async user() { return me; }, onAuth() {}, async signIn() {}, async signUp() { return {}; }, async signOut() {},
    async group() { return db.group; },
    async members() { return db.members.slice(); },
    async createGroup(name, display, phone) { db.myName = display; seed(name, phone); save(); return db.group; },
    async joinGroup(_c, display, phone) { db.myName = display; seed('Familien', phone); save(); return db.group; },
    async updateMe(_g, uid, fields) { Object.assign(db.members.find((m) => m.user_id === uid) || {}, fields); save(); fire('fa_members'); },
    async leave() { db.group = null; save(); },
    async messages() { return db.messages.slice(); },
    async sendMessage(gid, body, toAll, recipients) {
      const m = { id: crypto.randomUUID(), group_id: gid, sender: me.id, body, to_all: toAll, recipients, created_at: new Date().toISOString(), fa_acks: [] };
      db.messages.unshift(m); save(); fire('fa_messages'); return m;
    },
    async deleteMessage(id) { db.messages = db.messages.filter((m) => m.id !== id); save(); fire('fa_messages'); },
    async ack(id, on) {
      const m = db.messages.find((x) => x.id === id); if (!m) return;
      m.fa_acks = m.fa_acks.filter((a) => a.user_id !== me.id); if (on) m.fa_acks.push({ user_id: me.id });
      save(); fire('fa_acks');
    },
    async events() { return db.events.slice(); },
    async saveEvent(gid, ev) {
      if (ev.id) { const e = db.events.find((x) => x.id === ev.id); Object.assign(e, ev); save(); fire('fa_events'); return e; }
      const e = { ...ev, id: crypto.randomUUID(), group_id: gid, created_by: me.id }; db.events.push(e); save(); fire('fa_events'); return e;
    },
    async setDrivers(id, drivers) { const e = db.events.find((x) => x.id === id); if (e) e.drivers = drivers; save(); fire('fa_events'); },
    async deleteEvent(id) { db.events = db.events.filter((e) => e.id !== id); save(); fire('fa_events'); },
    subscribe(_g, c, onStatus) { cb = c; onStatus?.('SUBSCRIBED'); },
    async pushKey() { throw new Error('Varsler virker ikke i demomodus.'); },
    async savePush() {}, async deletePush() {}, async notify() {}, async testPush() {},
  };
}
