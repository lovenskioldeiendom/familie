// Supabase Edge Function «familie-varsel»: sender push-varsel om nye beskjeder i familieappen.
// Lim inn hele filen i Supabase → Edge Functions → «Deploy a new function» → «Via Editor».
// Ingen nøkler å sette opp: VAPID-nøklene lages automatisk første gang og lagres i tabellen fa_push_keys.
//
// Appen kaller funksjonen med innlogget bruker:
//   { action: 'key' }                    → { publicKey }  (offentlig nøkkel til å slå på varsler)
//   { action: 'send', message_id: '…' }  → varsler mottakerne av beskjeden (ikke avsender)
//   { action: 'test' }                   → sender et prøvevarsel til deg selv
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP_URL = 'https://lovenskioldeiendom.github.io/familie/';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Web Push (RFC 8291 + VAPID RFC 8292), kun WebCrypto ----------
const enc = new TextEncoder();
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, len: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

export type Sub = { endpoint: string; p256dh: string; auth: string };
export type Vapid = { publicKey: string; privateJwk: JsonWebKey };

export async function generateVapid(): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { publicKey: b64u(raw), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

async function vapidHeader(endpoint: string, v: Vapid) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL,
  })));
  const key = await crypto.subtle.importKey('jwk', { ...v.privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claims)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

export async function encryptPayload(sub: Sub, payload: Uint8Array) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

export async function sendPush(sub: Sub, data: unknown, v: Vapid) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, v),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 3600),
      Urgency: 'high',
    },
    body: await encryptPayload(sub, enc.encode(JSON.stringify(data))),
  });
  await res.body?.cancel();
  return res.status;
}

// ---------- Selve funksjonen ----------
// deno-lint-ignore no-explicit-any
type Db = any;
function serviceKey() {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); return k.default || Object.values(k)[0]; } catch { return ''; }
}

async function getVapid(admin: Db): Promise<Vapid> {
  const { data } = await admin.from('fa_push_keys').select('public_key, private_jwk').eq('id', 1).maybeSingle();
  if (data) return { publicKey: data.public_key, privateJwk: data.private_jwk };
  const v = await generateVapid();
  await admin.from('fa_push_keys').upsert({ id: 1, public_key: v.publicKey, private_jwk: v.privateJwk }, { onConflict: 'id', ignoreDuplicates: true });
  const again = await admin.from('fa_push_keys').select('public_key, private_jwk').eq('id', 1).single();
  if (again.error) throw new Error('Fant ikke tabellen fa_push_keys. Kjør supabase.sql på nytt. ' + again.error.message);
  return { publicKey: again.data.public_key, privateJwk: again.data.private_jwk };
}

async function pushTo(admin: Db, userIds: string[], data: unknown) {
  if (!userIds.length) return { sent: 0 };
  const v = await getVapid(admin);
  const { data: subs, error } = await admin.from('fa_push_subs').select('endpoint, p256dh, auth').in('user_id', userIds);
  if (error) throw error;
  let sent = 0;
  await Promise.all((subs || []).map(async (s: Sub) => {
    try {
      const st = await sendPush(s, data, v);
      if (st === 404 || st === 410) await admin.from('fa_push_subs').delete().eq('endpoint', s.endpoint); // telefonen har slått av varsler
      else if (st < 300) sent++;
      else console.log('push feilet', st, new URL(s.endpoint).host);
    } catch (e) { console.log('push feilet', String(e)); }
  }));
  return { sent };
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

if (typeof Deno !== 'undefined' && !Deno.env.get('FAMILIE_VARSEL_TEST')) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, serviceKey(), { auth: { persistSession: false } });
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: u } = await admin.auth.getUser(token);
    const me = u?.user;
    if (!me) return json({ error: 'Ikke logget inn' }, 401);
    const body = await req.json().catch(() => ({}));

    if (body.action === 'key') return json({ publicKey: (await getVapid(admin)).publicKey });

    if (body.action === 'test') {
      return json(await pushTo(admin, [me.id], {
        title: 'Varsler er på 🔔', body: 'Du får nå varsel når det kommer nye beskjeder.', tag: 'test', url: APP_URL + '?tab=msg',
      }));
    }

    if (body.action === 'send') {
      const { data: m } = await admin.from('fa_messages').select('*').eq('id', body.message_id).maybeSingle();
      if (!m || m.sender !== me.id) return json({ error: 'Fant ikke beskjeden' }, 404);
      if (Date.now() - new Date(m.created_at).getTime() > 10 * 60e3) return json({ error: 'For gammel beskjed' }, 400);
      const { data: members } = await admin.from('fa_members').select('user_id, display_name').eq('group_id', m.group_id);
      const all = (members || []).map((x: { user_id: string }) => x.user_id);
      const to = (m.to_all ? all : (m.recipients as string[]).filter((r) => all.includes(r))).filter((r) => r !== me.id);
      const from = (members || []).find((x: { user_id: string }) => x.user_id === me.id)?.display_name || 'Familien';
      return json(await pushTo(admin, to, {
        title: m.to_all ? from : `${from} (til deg)`, body: short(m.body, 180), tag: 'msg-' + m.id, url: APP_URL + '?tab=msg',
      }));
    }
    return json({ error: 'Ukjent handling' }, 400);
  } catch (e) {
    console.log(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
