# Familien

En enkel familieapp for mobilen: beskjeder, felles kalender og medlemsliste.
Laget som en nettside som kan legges på hjemskjermen (PWA). Ingen byggesteg.

## Hva den gjør
- **Beskjeder** til alle eller til valgte personer. Andre kan svare 👍.
- **Send også som SMS:** åpner meldingsappen på telefonen med mottakere og tekst ferdig utfylt (gratis, sendes fra eget nummer).
- **Kalender** med enkeltavtaler og avtaler som gjentas hver uke (f.eks. fotballtrening). «Hvem kjører?» per gang.
- **Familien:** medlemmer med navn og mobilnummer. Knapper for å ringe, sende SMS eller åpne Hvor er?-appen (📍, bare på iPhone/iPad).
- Medlemmer legger seg til selv med en 6-tegns kode.
- **Varsler** på telefonen når det kommer en ny beskjed til deg eller til alle (ikke til den som sendte).

## Oppsett (én gang)
1. Supabase → SQL Editor → lim inn hele `supabase.sql` → Run.
   Bruker samme Supabase-prosjekt som huskelista og matdagboken.
2. GitHub → Settings → Pages → Branch `main`, mappe `/ (root)` → Save.
3. Åpne https://lovenskioldeiendom.github.io/familie/ på mobilen og legg den på hjemskjermen.

### Varsler (én gang)
1. Kjør hele `supabase.sql` på nytt (den har fått tabeller for varsler).
2. Supabase → Edge Functions → «Deploy a new function» → «Via Editor». Navn: `familie-varsel`.
   Lim inn hele `supabase/functions/familie-varsel/index.ts` og trykk Deploy.
3. Åpne funksjonen → Settings → slå av «Verify JWT» → Save. (Funksjonen sjekker innloggingen selv.)
4. Hver person åpner appen fra hjemskjermen og trykker «Slå på» (iPhone: iOS 16.4 eller nyere).

Nøklene til varslene (VAPID) lages automatisk første gang og lagres i tabellen `fa_push_keys`.

Prøv uten database: legg `?demo` bak adressen.

## Filer
- `index.html`, `styles.css`, `app.js` – selve appen
- `data.js` – snakker med Supabase (eller lokal demo)
- `config.js` – Supabase-adresse og offentlig nøkkel
- `supabase.sql` – tabeller (prefiks `fa_`), tilgangsregler og sanntid
- `supabase/functions/familie-varsel/` – sender varsler om nye beskjeder
- `sw.js`, `manifest.webmanifest`, `icons/` – hjemskjerm og offline
