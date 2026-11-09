# MixAI Decks — ghid pentru controllere

Ghid pentru utilizatori: cum conectezi și configurezi un controller în MixAI Decks. Detaliile tehnice ale formatului
de mapare sunt în [mapping-format.md](mapping-format.md); arhitectura în [architecture.md](architecture.md).
Decizia de produs: D66 în [`docs/mixai-design-tracker.md`](../mixai-design-tracker.md).

> Stare 2026-11-09: profilurile sunt transcrise din documentația MIDI publicată de producători și testate automat
> pe acele liste; încă nu au fost verificate pe hardware fizic. Dacă un buton nu face ce scrie aici, folosește
> [MIDI learn](#midi-learn) și raportează problema.

## Controllere suportate din cutie

| Controller | Profil(uri) | Ce face |
|---|---|---|
| Pioneer DDJ-FLX4 | `pioneer-ddj-flx4-rekordbox`, `pioneer-ddj-flx4-serato` | 2 deck-uri, mixer, pad-uri în 8 moduri, Beat FX, LED-uri și VU |
| Novation Circuit Tracks | `novation-circuit-tracks`, `novation-circuit-tracks-clock-out` | clock master/slave, drum pads → samples sau hot cues, macro-uri → FX, groove lane |
| Orice claviatură MIDI (USB sau BLE) | `generic-midi-keyboard` | instrument blocat pe gama piesei care cântă |
| Orice controller MIDI necunoscut | `generic-2-deck` | 2 deck-uri de bază (play, cue, sync, EQ, volum, hot cues) |

## Pioneer DDJ-FLX4

### Alege layout-ul: rekordbox sau Serato

FLX4 trimite **exact aceleași mesaje MIDI** indiferent de software și nu are un comutator de mod, deci MixAI Decks
**nu poate detecta automat** ce layout ai în minte (ce scrie pe carcasă / în ghidul pe care îl folosești).
Layout-ul se alege astfel, în ordine:

1. **Preferința ta** din *Setări → Controllere → DDJ-FLX4 → Layout* (`rekordbox` sau `Serato`).
2. Dacă nu ai ales: software-ul din care ți-ai importat biblioteca (import din Serato → layout Serato).
3. Altfel: un indiciu din numele portului MIDI, iar implicit **rekordbox**.

Diferențe între cele două layout-uri (aceleași butoane, alte funcții):

| Control | rekordbox | Serato |
|---|---|---|
| SHIFT + PLAY | — | stutter |
| SHIFT + OUT | — | vinyl mode |
| CUE/LOOP CALL ◀ ▶ | memory cue call | loop ½ / 2× |
| Moduri pad cu SHIFT | Keyboard / Pad FX 2 / Beat Loop | Pitch Play / Roll / Auto Loop |
| Sampler | sloturile 1–16 împărțite pe deck-uri | sloturile 1–8 pe fiecare deck |
| SHIFT + LOAD | — | sortare în bibliotecă |

Pad-urile au 8 moduri: Hot Cue, Pad FX 1, Beat Jump, Sampler, Keyboard / Pitch Play, Pad FX 2 / Roll, Beat Loop /
Auto Loop, Key Shift. Toate potențiometrele și fader-ele sunt pe 14 biți (rezoluție fină), jog-urile sunt relative,
cu atingere detectată pe platou.

### Conectare

1. Conectează FLX4 prin USB (alimentarea vine tot din USB).
2. Deschide MixAI Decks: profilul se încarcă singur după numele dispozitivului.
3. Verifică layout-ul în *Setări → Controllere* și mută fader-ele o dată: valorile se „prind” fără salturi
   (soft takeover).

## Novation Circuit Tracks

### Clock: master sau slave

| Mod | Profil | Când îl folosești |
|---|---|---|
| **Circuit = master** (Decks urmează) | `novation-circuit-tracks` | Cânți un pattern pe Circuit și vrei ca deck-urile să se sincronizeze pe tempo-ul lui. Decks citește clock-ul MIDI, start / stop / continue și song position; tempo-ul se stabilizează în ~2 bătăi. |
| **Decks = master** (Circuit urmează) | `novation-circuit-tracks-clock-out` | Mixezi piese și vrei ca pattern-urile Circuit să cânte pe tempo-ul și pe beatgrid-ul deck-ului master. Primul tick e aliniat pe downbeat. |

Pe Circuit setează *Clock In* / *Clock Out* corespunzător în Setup (vezi manualul Novation).

### Pad-uri, macro-uri, pattern-uri

- **Drum pads** (canal 10): implicit declanșează sloturile 1–4 din sampler. Ține apăsat modificatorul
  *Drums → Cues* din Decks și aceleași pad-uri devin hot cues 1–4 pe deck 1.
- **Synth 1 / Synth 2**: notele sunt corectate pe gama piesei care cântă (scale lock), deci nu poți cânta fals peste
  mix.
- **Macro-uri 1–8**: parametri ai unităților FX 1 / 2, cu soft takeover.
- **Pattern-uri**: program change 0–63 schimbă imediat, 64–127 la finalul pattern-ului curent (queued).
- **Filtru master** și rezonanță de pe canalul de proiect (CC 74 / 71).

### Groove lane

Groove lane înregistrează ce cânți pe Circuit (synth 1, synth 2, drums) direct pe beatgrid-ul piesei: cuantizare pe
șaisprezecimi, buclă de 4 măsuri, overdub care înlocuiește aceeași notă pe același pas. Pattern-ul rămâne salvat cu
piesa (JSON) și poate fi redat de Decks spre Circuit sau spre sampler, sincron cu deck-ul.

## Claviatură MIDI cu scale lock

Orice claviatură MIDI (USB sau Bluetooth) se mapează pe `generic-midi-keyboard`:

- clapele cântă instrumentul din sampler **în tonalitatea piesei** de pe deck-ul activ; notele din afara gamei sunt
  rotunjite în jos (de exemplu Mi în Do minor → Mi♭);
- ține pedala de sustain (CC 64) și clapele 36–51 devin sloturile 1–16 din sampler;
- pitch bend → tempo deck 1 ±8 %; mod wheel → primul parametru din FX 1.

Tonalitatea vine din analiza locală (`mixai-listen`), deci funcționează și offline.

## Bluetooth (BLE) MIDI pe fiecare sistem

| Sistem | Cum împerechezi | Observații |
|---|---|---|
| Windows 11 | *Setări → Bluetooth* apoi deschide Decks | Windows MIDI Services (inclus în Windows 11 24H2/25H2) expune dispozitivele BLE MIDI ca porturi MIDI normale. Pe versiuni mai vechi Decks folosește direct GATT. |
| macOS | *Audio MIDI Setup → Window → Show MIDI Studio → Bluetooth* | După împerechere apare ca port CoreMIDI obișnuit. |
| iOS / iPadOS | din Decks: *Setări → Controllere → Bluetooth* | Dialogul de sistem Apple (`CABTMIDICentralViewController`). |
| Android | din Decks: *Setări → Controllere → Bluetooth* | `android.media.midi` deschide dispozitivul; timestamp-urile vin deja decodate. |
| Linux | `bluetoothctl` (BlueZ compilat cu suport MIDI) | Apare ca port ALSA sequencer. |

BLE adaugă latență (de obicei 7,5–15 ms per interval de conexiune); pentru scratch folosește USB.

## MIDI learn

Pentru orice control care nu e mapat (sau mapat altfel decât vrei):

1. *Setări → Controllere → MIDI learn* și alege acțiunea (de exemplu „Loop ½ pe deck 2”).
2. Mișcă butonul / fader-ul / encoderul pe controller.
3. După ~300 ms de liniște gestul e recunoscut: Decks detectează singur CC simplu, CC pe 14 biți, NRPN sau encoder
   relativ (toate cele trei codări uzuale). Un Note On e recunoscut imediat.
4. Salvează. Controlul învățat primește automat soft takeover.

Maparea învățată se salvează ca fișier JSON în profilul tău de controller și se poate exporta.

## Mapări proprii

Mapările sunt fișiere JSON (format v1, cu JSON Schema) plus un script opțional într-un sandbox (fără acces la
fișiere sau rețea, cu limite de timp). Specificația completă, vocabularul de acțiuni și exemple:
[mapping-format.md](mapping-format.md).

Regulă de licență: mapările incluse vin doar din documentația publicată de producători; mapările Mixxx (GPL) nu pot
fi importate.

## Glosar

| Termen | Sens |
|---|---|
| soft takeover | valoarea din software se schimbă doar după ce controlul fizic „trece” prin ea, fără salturi |
| clock master / slave | cine dă tempo-ul (master) și cine îl urmează (slave) prin MIDI clock |
| scale lock | notele cântate sunt corectate pe gama (tonalitatea) piesei |
| groove lane | pistă care înregistrează note pe beatgrid-ul piesei |
| hot cue | punct de start salvat, declanșat de un pad |
| 14 biți | controlul trimite 16 384 de trepte în loc de 128 |
