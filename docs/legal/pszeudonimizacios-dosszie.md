# Persistent Cart — pszeudonimizációs dosszié (#261)

Készült: 2026-08-08. Kérdés, amit bármely adatvédelmi ügyvéd fel fog tenni:
**visszafejthető-e a vásárló a mi adatainkból, milyen mezőkből, és mit tettünk
ellene?** Jelölt-független termék-tény, kód-mérésekből (nem feltételezésből).

## 1. Mit tárolunk vásárlóról, és milyen formában
Nyers Shopify `customerId` HÁROM modellben: CartToken, SavedCart, ShortUrl.
Mindháromnál a szerep EGYEZŐSÉG-vizsgálat vagy kikeresés (unique index / index) —
egyetlen hely sincs, ahol magára az eredeti értékre mint tartalomra szükség
lenne. (Az OrderConversion.customerId a 2026-07-24-i javítással már KIKERÜLT.)
A customerId GDPR Art.4(1) szerint pszeudonim személyes adat: önmagában nem
azonosít, de a Shopify vagy a Merchant vissza tudja kötni egy személyhez.

## 2. Re-identifikációs út — a nem-nyilvánvaló rész
Az app scope-jai: read_orders, write_products, három unauthenticated storefront.
**read_customers NINCS**, tehát a vásárló rekordja közvetlenül nem kérdezhető le
a mi tokenünkkel. VISZONT a **read_orders** benne van, és a Shopify
rendelés-objektum tartalmaz vásárlói adatot — vagyis egy elméleti re-identifikáció
útja nem a mi tárolt mezőnk önmagában, hanem a customerId + a Shopify felé
meglévő read_orders jog kombinációja. Ezt a jellemzést (mekkora tényleges
re-identifikációs kockázat, és kell-e szűkíteni a scope-ot) érdemes a
szakvéleményben megnézetni.

## 3. Hol látható a customerId a Merchant felé
Az activity log a `details` MINDEN kulcsát kiírja (app.activity.jsx generikus
Object.entries), tehát amit a naplóba teszünk, a Merchant látja. A customerId öt
akcióban kerül a naplóba: saved_cart_restored (napi működésben élő),
customer_data_request, customer_redact, plusz három limit-esemény.

## 4. Tervezési döntés: miért NEM egységes hash (mérlegelt, #261)
Egységes hash-sel a customerId eltűnne a naplóból, de két valós veszteség járna:
- saved_cart_restored: ma a Merchant a saját adminjában névre oldja, KINEK a
  kosarát állítottuk vissza — ez legitim működési információ a Merchantnak
  (adatkezelő), nem a mi többlet-expozíciónk.
- GDPR-sorok (adatkérés/törlés): ezek a bejegyzések PONTOSAN attól bizonyítják a
  webhook teljesítését, hogy az érintettre mutatnak; hash-sel a bizonyító erő
  gyengülne.
A customerId a Merchant adatkezelői körében marad látható; a peci nem tárol
olyan mezőt, amelyre a nyers érték mint tartalom kellene. Ezt a döntést (hash
vs. jelenlegi) a szakvéleményben meg lehet erősíttetni vagy felülbíráltatni.

## 5. Mit tettünk már a re-identifikáció szűkítésére (kód-igazolt)
- customerId eltávolítva az OrderConversion-ból (2026-07-24).
- OrderConversion redactre anonimizálva (minden azonosító null), rekord 365 nap
  után törölve.
- Uninstall/shop_redact: teljes purge (minden vásárlói adat + access token).
- read_customers NINCS a scope-ok között.

## 6. Nyitott kérdés a szakvéleményhez
A 2. pont szerinti read_orders-alapú re-identifikációs út tényleges kockázati
súlya és a scope-minimalizálás kérdése; valamint a 4. pontbeli napló-jellemzés
(customerId a Merchant-látható logban) adatvédelmi megítélése adatfeldolgozói
szerepben.
