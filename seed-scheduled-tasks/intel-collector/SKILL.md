---
name: intel-collector
description: Proaktív hírszerző -- óránkénti gyűjtés a saját figyelt témáidban, eredmény az intel registry-be (store/intel.db). A napi brief (intel-napi-brief) ebből épül.
---

# Proaktív hírszerző -- óránkénti gyűjtő ciklus

> ⚠️ SABLON: alapból KIKAPCSOLVA érkezik (task-config.json: `"enabled": false`).
> Mielőtt bekapcsolod, cseréld le az alábbi DOMAIN blokkokat a SAJÁT figyelt
> témáidra. A "FUTÁS VÉGE" szakasz (registry-írás) a rendszer fix része, azt
> ne vedd ki -- az táplálja a napi briefet.

Cél: a megadott domainek átfésülése, és MINDEN releváns találat beírása a
registry-be. CSAK akkor küldj Telegram üzenetet a tulajdonosnak ({{OWNER_NAME}}),
ha riasztás-szintű esemény van (általad definiált küszöb átlépése, sürgős
határidő). Egyébként csendes futás: registry + napi napló.

## DOMAIN 1 -- [CSERÉLD LE: pl. iparági hírek / versenytársak]

1. WebSearch query-k (2-4 darab, a te témádra szabva):
   - "[KULCSSZÓ 1] 2026" site:[MEGBÍZHATÓ FORRÁS]
   - "[VERSENYTÁRS NÉV]" (legfrissebb hír)

2. Minden találatnál rövid triage: tartalmaz-e számszerű adatot, bejelentést,
   határidőt ami a tulajdonost érinti? Ha van helyi LLM (Ollama MCP), az
   előszűrést delegálhatod oda IGEN/NEM formátumban -- token-takarékos.

3. Csak a releváns rekordokat dolgozd fel. Ha a saját küszöbödet átlépi
   (pl. >X% árelmozdulás) -> Telegram értesítés.

## DOMAIN 2 -- [CSERÉLD LE: pl. árfolyamok / piaci adatok]

1. WebFetch [HIVATALOS FORRÁS URL, pl. jegybanki árfolyamoldal]
   Sáv-trigger példa: ha az érték a [ALSÓ]..[FELSŐ] sávon kívül van -> AZONNALI Telegram.

2. Ritkább ellenőrzések időkapuval (pl. csak 09:00-kor, csak hétfőn, csak a
   hónap 1-jén): így az óránkénti futás olcsó marad. Első lépésként `date`
   Bash paranccsal nézd meg a pontos időt.

## DOMAIN 3 -- [CSERÉLD LE: pl. jogszabály / pályázat / határidők -- vagy töröld]

1. WebFetch [FORRÁS URL]
   Triage: van-e új kör / új határidő? Ha IGEN -> Telegram.

## FUTÁS VÉGE (fix rész -- ez táplálja a napi briefet)

1. REGISTRY-ÍRÁS (kötelező): MINDEN releváns találatot írj be a
   known_facts_registry-be a CLI-vel:
   ```
   python3 {{INSTALL_DIR}}/scripts/intel_db.py add-fact \
     --title "RÖVID CÍM" --domain <a-te-domain-sluggod> \
     --source "URL vagy forrásnév" --tier <1|2|3> \
     --content "A tény tömör tartalma számokkal" --priority <0.0-1.0>
   ```
   - Az --id-t NE add meg: a CLI determinista id-t generál (domain-YYYYMMDD-hash8),
     így az óránkénti ismételt találat update lesz, nem duplikátum.
   - "DUPLICATE content already in registry" kimenet = már ismert tény, rendben, lépj tovább.
   - priority ökölszabály: riasztás-szintű trigger = 0.9; számszerű adat vagy
     határidő = 0.7; egyéb releváns = 0.5. Tier-1 forrás: +0.1, tier-3: -0.1
     (0..1 közé vágva).
   - Ha egy KORÁBBI tény fejlődött tovább (ugyanaz a téma új számmal), ugyanazzal
     az --id-vel írd felül és --status evolving.
2. Új követendő irány (még nem tény, de figyelni érdemes): add-watch:
   ```
   python3 {{INSTALL_DIR}}/scripts/intel_db.py add-watch \
     --title "MIT" --domain <domain> --direction "MERRE mozdulhat" --notes "MIÉRT"
   ```
3. POST /api/daily-log (agent_id: {{MAIN_AGENT_ID}}) -- mi futott, hány fact
   került a registry-be, státusz.
4. Ha nincs riasztás: csend (a registry-írás NEM riasztás, arról nem megy Telegram).
5. Ha riasztás: Telegram a tulajdonosnak, tömören, actionable formában.
