# Kanban audit: 4b. waiting-kor ellenorzes (references)

4b. **WAITING-KOR ELLENORZES (2026-07-27-tol, ez eddig HIANYZOTT az eljarasbol)**: az audit
   eddig CSAK az `in_progress` beakadast nezte, a `waiting`-et sosem. Emiatt 12 kartya ult
   30+ napja eszrevetlenul, koztuk egy biztonsagi fix (34 nap) es egy kulso embernek jaro
   valasz (5 nap ota jovahagyasra varva).
   ```sql
   SELECT id, assignee, date(updated_at,'unixepoch','localtime'), substr(title,1,60)
     FROM kanban_cards
    WHERE archived_at IS NULL AND status='waiting'
      AND updated_at < strftime('%s','now','-30 days')
    ORDER BY updated_at
   ```
   (Futtatas a fenti python3-sqlite wrapperrel.)
   - A puszta szamot NE jelentsd a tulajdonosnak minden korben (az is zajja valna). Akkor szolj, ha
     a szam NO az elozo audit ota, vagy ha van kozte olyan ami KULSO emberre/biztonsagra
     vonatkozik.
   - **DE A NOVEKEDESNEK KET KULON OKA LEHET, ES CSAK AZ EGYIK LELET (2026-08-08, merve).**
     A 16:00-as audit 3-rol 4-re novo szamot mert -- es a negyedik NEM uj problema volt: a
     `cbe2a240` (update-rendszer overhaul) AZNAP lepte at a 30 napot, valtozatlan tartalommal.
     Ha a puszta szam-novekedesre jelentesz, akkor minden alkalommal riasztasz, amikor egy regi
     kartya egyszeruen megoregszik -- a jelzes igy a naptartol fugg, nem a valosagtol.
     **ELJARAS: bontsd KET reszre, mielott jelentesz.** (a) UJ BELEPO: az elozo audit ota KERULT
     `waiting`-be es mar 30+ napos -- ritka, es valodi lelet. (b) ATLEPO: mar `waiting`-en ult,
     csak most erte el a 30 napot -- ez a naptar muve, nem valtozas. Jelentes CSAK az (a)-ra,
     illetve a kulso-ember/biztonsagi kiemelesre; az (b) a transzkriptbe megy, es a helye a
     kovetkezo prioritas-merlegeles. A megkulonboztetes egy lekerdezes: ha a kartya `updated_at`-ja
     REGEBBI mint az elozo `last_audit_at`, akkor ATLEPO.

     **DE A FENTI MONDATBOL EGY OLYAN LEKERDEZES KOVETKEZIK, AMI SOSEM TUD TUZELNI -- ELSULT NALAM
     (2026-08-19 11:5x, sajat hiba, elkapva a kor kozben).** A szoveget ugy olvastam, hogy az UJ BELEPO
     az, aminek az `updated_at`-ja az elozo audit UTANI, es ezt irtam: `updated_at >= LAST AND
     updated_at < now-30 days`. **Ez a ket feltetel egyszerre SOSEM igaz:** ami negy oraja frissult, az
     nem lehet 30 napja allo. A lekerdezes tehat MINDIG nullat ad, es a nulla ugy nez ki, mint egy
     megnyugtato mereseredmeny. Pontosan az a fajta metrika, amit semmilyen valosag nem tud megcafolni
     (lasd [[feedback_a_metric_needs_a_refuter]]).
     **A HELYES ATLEPO-LEKERDEZES, masolhatoan:**
     ```sql
     -- azok, akik az ELOZO AUDIT OTA leptek at a 30 napos hataron
     SELECT id, assignee, datetime(updated_at,'unixepoch','localtime'), substr(title,1,45)
       FROM kanban_cards
      WHERE archived_at IS NULL AND status='waiting'
        AND updated_at <  strftime('%s','now','-30 days')   -- MA mar 30+ napos
        AND updated_at >= <LAST> - 30*86400;                -- az ELOZO auditkor MEG NEM volt az
     ```
     Ez 2026-08-19-en ket kartyat adott (E728AE14, E3702858, mindketto 2026-07-20 11:25) -- vagyis a
     muszer tuzel, amikor van mit talalnia.
     **ES AZ (a) AG A GYAKORLATBAN MAJDNEM URES HALMAZ:** ahhoz, hogy egy kartya az elozo audit ota
     KERULJON `waiting`-be ES rogton 30+ napos legyen, az kellene, hogy a statusz-valtas NE frissitse
     az `updated_at`-ot. Nalunk frissiti. Ezert az (a)-t ne detektorral keresd, hanem a statusz-valtas
     pillanataban -- a jelentes valodi targya az ATLEPO-lista es a kulso-ember/biztonsagi kiemeles.
   - A backlog-metszes GAZDA-DONTES, ne csinald magadtol (lasd a deep-clean buktatot).
     A te dolgod a lista eloallitasa. Jelentsd: vizsgált=N,találat=K,0→nemmért.
