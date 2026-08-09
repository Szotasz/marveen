# Megkereső-címzettek (hétfő 2026-08-10 09:30 küldéshez)

A küldő ütemezett feladat EBBŐL a fájlból olvassa a címzetteket. Amelyik
sorban HIANYZIK áll, azt NEM küldi, hanem jelez Viktornak (fail-closed).
A címek forrása: az iroda SAJÁT weboldala (quarantine-fetch, 2026-08-09);
minden cím mellett a forrás-URL.

| # | levél | címzett | email | forrás |
|---|-------|---------|-------|--------|
| 1 | Accace Legal | Accace Legal | VIKTOR KULDI KEZZEL az urlapon (tg2558) -- az utemezett kuldes KIHAGYJA | accace.com/hu oldalak, 2026-08-09 |
| 2 | NG Legal | NG Legal (dr. Nagy Gabriella Ügyvédi Iroda) | office@nglegal.hu | nglegal.hu/kapcsolat (2026-08-09) |
| 3 | Dr. Olajos József | Dr. Olajos József | info@gdpr24.hu | gdpr24.hu/adatkezelesi-tajekoztato (2026-08-09) -- Viktor: KULDJUK (tg2556) |
| 4 | Dr. Fördős Ádám | Dr. Fördős Ádám | dr.fordosadam@gmail.com | drfordosadam.hu/kapcsolat (2026-08-09) |

Feladó minden levélnél: Tolnai Viktor <viktor.tolnai@peci.io> (Zoho SMTP,
send.py --from-address --from-name). Melléklet NINCS (a lépcsőzött zárás
szerint az anyagok az iroda visszajelzése után mennek).

NYITOTT DÖNTÉSEK (Viktor, tg2553/tg2555 kérdései alapján):
- #3 Olajos: ELDÖNTVE (Viktor, tg2556): KÜLDJÜK. Feltétele volt a
  sablon-utalás kivétele a leveléből -- teljesült: a "sablon" szó a jelenlegi
  levelekben sehol nem szerepel (a szerkezeti átírásnál kikerült, géppel
  ellenőrizve).
- #1 Accace: ELDÖNTVE (Viktor, tg2558): Viktor maga küldi reggel a
  kapcsolatfelvételi űrlapon. Az ütemezett küldés az Accace-t kihagyja,
  a másolásra kész csomag a #294 alatti Viktor-subtaskon.
Nincs több függő tétel: az ütemezett feladat a 2., 3., 4. levelet küldi.
