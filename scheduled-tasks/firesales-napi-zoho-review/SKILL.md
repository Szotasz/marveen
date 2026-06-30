---
name: firesales-napi-zoho-review
description: Napi Zoho sales-review a sales-csapatnak (Slack) #értékesítés
---

# Napi Zoho CRM pipeline-review

## Lepesek

1. **Adatlekereses** -- FONTOS (2026-06-14): a hosted Zoho MCP gateway TOROTT (Connection Error + timeout, mindket auth-modban), a `ZohoCRM_*` MCP tool-ok NEM mukodnek. A dealeket a DIREKT REST connectorral huzd le (auto-refresh self-client tokennel). Lasd `zoho-crm-direct-rest`.

   **TILOS a `Deals` (page_token-os, Modified_Time desc) tomeges pull (2026-06-30 bug):** a Zoho page_token paginazas NEM honoralja a `sort_by`-t, ezert a 2025-10-es Un-qualified holt bulk-importot (~3942 db, 0 ertek) hozza fel, es az aktiv pipeline javat (Cetin, SMP-OTP BG, DS Smith stb.) ELDOBJA. Ne hasznald, mert nemaul rossz (26 deal / ~80k a valos 317 / ~960k helyett) snapshotot ad. Helyette **per-stage criteria-search** (ez az autoritativ ut, egyezik a tortenettel):
   - Nyitott pipeline -> /tmp/zoho_open.json:
     ```
     python3 - <<'PY'
     import sys, json; sys.path.insert(0,"/root/marveen/scripts")
     from zoho_crm import call
     f="Deal_Name,Account_Name,Owner,Stage,Amount,Closing_Date,Created_Time,Modified_Time"
     OPEN=["Qualified - Prospect","Presentation, discovery","Proposal","Contract"]
     allopen={}
     for st in OPEN:
         page=1
         while page<=10:
             code,txt=call("Deals/search", {"criteria":f"(Stage:equals:{st})","fields":f,"per_page":200,"page":page})
             if code==204: break
             if code!=200: print("ERR",st,code,txt[:200]); break
             b=json.loads(txt)
             for x in b.get("data",[]): allopen[x.get("id")]=x
             if not b.get("info",{}).get("more_records"): break
             page+=1
     json.dump(list(allopen.values()), open("/tmp/zoho_open.json","w"), ensure_ascii=False)
     print("open", len(allopen))   # ~317 a helyes nagysagrend; ha <50, valami eltort -> ne posztolj, jelezd Bossnak
     PY
     ```
   - Friss zarasok (win/loss valtozas-detektalashoz) -> /tmp/zoho_closed.json:
     ```
     python3 - <<'PY'
     import sys, json; sys.path.insert(0,"/root/marveen/scripts")
     from zoho_crm import call
     f="Deal_Name,Owner,Stage,Amount,Closing_Date,Modified_Time"
     out=[]
     for st in ["Closed Won","Lost","Discontinue - NO SALES"]:
         code,txt=call("Deals/search", {"criteria":f"(Stage:equals:{st})","fields":f,"per_page":200,"page":1,"sort_by":"Modified_Time","sort_order":"desc"})
         if code==200: out+=json.loads(txt).get("data",[])
     json.dump(out, open("/tmp/zoho_closed.json","w"), ensure_ascii=False); print("closed", len(out))
     PY
     ```
   - Friss leadek: `python3 /root/marveen/scripts/zoho_crm.py leads --per-page 50`
   - A /tmp/zoho_open.json a nyitott (aktiv) pipeline; gazdatlan = "ZOHO admin FelhőNet" felelos. Uj Megnyert/Bukas a /tmp/zoho_closed.json-bol (szurd a Modified_Time >= utolso review datuma feltetellel). A page_token a `Deals/search`-nel sem kell: a `page`-szamos lapozas a criteria-searchnel helyesen vegigmegy a talalati halmazon.

2. **Osszehasonlitas**: az utolso review snapshotjahoz kepest (warm memoriaban tarolva keyword "zoho-napi-snapshot"). Mi mozdult elore/hatra, mi uj, mi zart, mi rekedt 45+ napja. Frissitsd a snapshotot a mostani allapottal.

3. **SLACK kuldes a sales-csapatnak** (#sales-csoport, channel ID `C087LRSR9CG`, Slack Web API chat.postMessage) -- **EZ A NAPI REVIEW DEFAULT CELJA** (Attila korrekcio 2026-06-09, mem hozza). NE Attila szemelyes DM-jebe (U05506KERR7) -- az csak ad-hoc service-uzenetekre. A csapat (Janos, Joco, Zoli) ezt a channelt olvassa:
   - Bot token forrasa: `/root/marveen/store/.slack-tokens` -> `SLACK_BOT_TOKEN` sor (a regi macbook-path `/Users/macbook/.claude.json` NEM letezik a prometheus-cutover ota). A kep-feltoltest a kesz `python3 /root/marveen/scripts/slack-upload.py <png> C087LRSR9CG "<caption>"` scripttel intezd (ez maga olvassa a tokent); szoveges chat.postMessage-hez a tokent a fenti fajlbol vedd.
   - **STILUS-MINTA: mem 523** (a januari email-stilus). Folyoszoveges magyarazat, NEM nyers bullet-dump.
   - **Koszonto**: "Sziasztok Jocó, Zoli, János!" + 1 mondat ami kontextust ad (pl. "Reggel megneztuk a Zohot pentek ota...")
   - **NAGYBETŰS ROVATCIMEK** (NEM `*bold*` mrkdwn): A HELYZET PÉNTEK ÓTA / FIGYELEM / FÓKUSZBAN MA
   - **FÓKUSZBAN MA**: nem mereven 3 (mem 522), hanem annyi amennyi indokolt (~max 7-8). Nevezd meg melyik deal kihez tartozik. Sales csapat (Zoho deal-owner, Attila megerositette 2026-06-04): Jocó = Konkoly József, Zoli = Pungor Zoltán, János = Arany János. (Attila maga = Fekete Attila a Zohoban.) Csak ezt a harom sales kollegat szolitsd meg.
   - **Helyes magyar ekezetekkel** mindenutt: "Tűzfék", "Fővárosi", "Köfém", stb.
   - **DÁTUM-FORMÁTUM (Attila KÖTELEZŐ szabálya, 2026.06.14., megerősítve 2026.06.15. bosszúsan)**: minden MEGJELENŐ dátum magyar formában, PONTOKKAL: `yyyy.mm.dd.` (pl. 2026.06.15.), SOHA kötőjellel (NEM 2026-06-15). Vonatkozik a CHART CÍMÉRE ("fiREG pipeline fázis- és értékbontás - 2026.06.15."), a poszt szövegére és MINDEN megjelenő dátumra. A `/tmp/...png` fájlnév maradhat kötőjeles (nem látszik), de a cím SOHA.
   - **Slack lista karakterek**: `•` ahol valoban felsorolas, tobbi folyoszoveg
   - **ALAIRAS**: "Üdv,\nSales, a barátotok" (NEM "-- Sales barátotok" -- Attila 2026-06-08-i minta szerint)
   - **NINCS** "szóljatok / blokkolot jelezzetek" zaras (egyiranyu poszt, mem 429)
   - Hossz: ~2500-3500 karakter (a regi 1500-1700 NEM ervenyes -- a folyoszoveges stilus hosszabb)
   - chat.postMessage payload: `{"channel":"C087LRSR9CG","text":"...","mrkdwn":true,"unfurl_links":false,"unfurl_media":false}`

4. **KEP melleklet** (Slack-hoz KOTELEZO Attila 2026-06-08 9:37 jovahagyott canon mem 525 szerint): matplotlib pipeline-overview kep, 2 panel (bal: aktív deal-darab fázis szerint stacked bar Jocó/Zoli/Gazdátlan, jobb: értékösszeg EUR stacked bar). Mentsd /tmp/sales-pipeline-YYYY-MM-DD.png, dpi=120, ~13x5.5 inch. Slack-csatornahoz files.getUploadURLExternal -> binary upload -> files.completeUploadExternal sorrendben (channel_id: C087LRSR9CG). Telegramnal a kep is mehet ugyanazzal a reply tool files parameteren keresztul.

5. **AKTIVITAS-KEP (Attila 2026-06-22, KOTELEZO a review reszekent)**: a pipeline-poszt + pipeline-chart MELLE MINDIG menjen az aktivitas-kep is, UGYANEBBE a #sales-csoport (C087LRSR9CG) csatornaba, CSAK A KEP, szoveg/caption nelkul. EZ A FOLYAMAT RESZE, nem kulon poszt. NEM megy Telegramra (a kulon Telegram-aktivitas-riport megszunt).
   - Ablak a megbeszelt ritmusban: futtass `date '+%u'` (1=hetfo..7=vasarnap, Europe/Budapest).
   - Ha HETFO (1) -> mult het: start=`date -d '-7 days' +%Y-%m-%d`, end=`date -d '-2 days' +%Y-%m-%d` (exkluziv, Mon-Fri), label pl. 'múlt hét (2026.06.15-06.19.)'.
   - Ha KEDD-PENTEK (2-5) -> elozo munkanap: start=`date -d yesterday +%Y-%m-%d`, end=`date +%Y-%m-%d` (exkluziv), label pl. 'csütörtök (2026.06.19.)'.
   - Generald: `python3 /root/marveen/scripts/sales_activity.py <start> <end> "<label>" /tmp/sales-aktivitas-<start>.png` (a stdout szoveget NE posztold, csak a PNG kell).
   - Toltsd fel CAPTION NELKUL (csak a kep): `python3 /root/marveen/scripts/slack-upload.py /tmp/sales-aktivitas-<start>.png C087LRSR9CG` (3. argumentum elhagyva = nincs szoveg).

6. **Kritikus valtozas eseten**: ha uj nagy deal (10k+), contract->lost, vagy 10k+ erteku stage-mozgas tortent, kulon inter-agent uzenet Boss-nak (attilaknowsthatteambot) reszletesen.

## Fontos

- Slackre **csak ezen a napi rutinon belul** posztolj automatikusan -- ad-hoc kuldes csak explicit Attila/Boss keresere.
- Ha a Slack chat.postMessage failel, **NE** ujraprobald masodik hivassal (deduplication issue). Naplozd a hibat es kuldj inter-agent uzenetet Boss-nak (attilaknowsthatteambot), hogy a mai Slack-review nem ment ki. NE kuldd a review-t Attila Telegramjara (Attila 2026-06-14: nem keri a napi sales-masolatot).
- Az egyiranyu csapat-posztban tilos "szoljatok ha kerdes" tipusu zaras.
