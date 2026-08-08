# Persistent Cart — adat-térkép (ügyvédi átnézéshez)

Készült: 2026-08-08 (#52/#261). Cél: a jogász FIX, átnézhető bemenetet kapjon,
hogy a szakvélemény ráfordítása kalkulálható legyen. Forrás: a kód-verifikált
LEGAL_DRAFT_v2 adat-modellje (peci.io-marketing repo), a #261 mérések.
Szerep: a peci **adatfeldolgozó** (GDPR 4(8)) a Merchant (adatkezelő) nevében.

## 1. Milyen személyes adatot kezel az app (Customer, adatfeldolgozóként)
| Kategória | Mező | Forrás | Cél | Jogalap | Megőrzés |
|---|---|---|---|---|---|
| Shopify vásárló-azonosító | Shopify customer ID (numerikus, PSZEUDONIM) | Storefront API, webhook | Mentett kosár + kosár-token a vásárló fiókjához kötése | Art.28 Merchant-utasításra; Merchant alapja Art.6(1)(b)/(f) | Törlés kosár-lejáratkor (csomag-függő) vagy shop/customer redact webhookra |
| Kosár-token | Opaque cart token (Shopify által generált) | Storefront API | A helyes kosár visszakeresése bármely eszközön | Art.28 Merchant-utasításra | Ua. |
| Rendelés-attribúció | Shopify order ID/name, végösszeg, attribúciós mód, cart token (OrderConversion — customer-azonosítót NEM tárol) | rendelés-webhook | Rendelés-attribúció | Art.28 | Redact webhookra ANONIMIZÁLVA (order id/name/referrer/cart token/link-click null); a rekord 365 nap után törlődik |

Megjegyzés: a Shopify customer ID önmagában nem fed fel identitást, de PSZEUDONIM
személyes adat (Art.4(1)), mert a Shopify vagy a Merchant vissza tudja kötni
egy személyhez. Csak a bejelentkezett session mentett kosárhoz illesztésére
használjuk.

## 2. Merchant/üzemeltetői adat (adatkezelőként a saját ügyfél-viszonyban)
Session, Merchant, MerchantCredential (offline access token, Storefront Access
Token, refresh token), MerchantUsage, MerchantSettings. Uninstall / shop redact
webhookra: MINDEN merchant/shop személyes adat és MINDEN Shopify access token
törlődik — 30 napon belül, tipikusan 48 órán belül. Access token uninstall után
nem marad.

## 3. Megőrzés / törlés (kód-igazolt)
- Napi cron (~03:00, Vercel) törli a lejárt CartToken/SavedCart rekordokat;
  ShortUrl lejáratkor, a LinkClick kaszkádban.
- OrderConversion: redactre anonimizálva, a rekord 365 nap után törölve.
- Uninstall/shop_redact: teljes purge (lásd 2. pont).
- Egyetlen túlélő: UninstalledRegistry (shop domain, utolsó csomagnév, uninstall
  időbélyeg) 90 napig csalás-megelőzés/számlázás-egyeztetés miatt, majd törölve —
  NINCS benne vásárlói adat és access token.
- Számviteli kötelezettség (2000. évi C. tv.): csak NEM-személyes/aggregált
  rekord marad (összeg, dátum, csomag, számla-hivatkozás).

## 4. Adatfeldolgozók (sub-processzorok) + biztonság
- Neon (adatbázis) — at-rest titkosítás.
- Vercel (hosting/cron).
- Shopify (platform).
- Adat titkosítva átvitelben (HTTPS/TLS, `sslmode=require` + `channel_binding=require`)
  és nyugalmi állapotban (Neon). A Shopify access tokenek a DB-ben, így az
  at-rest titkosítás fedi; app-rétegű plusz titkosítás nincs; uninstall/redactkor
  purge-ölve.

## 5. Jogosultsági kör (Shopify scope-ok) — releváns a re-identifikációhoz
read_orders, write_products, + három unauthenticated storefront scope.
**read_customers NINCS** — a vásárló rekordja közvetlenül nem kérdezhető le.
(A re-identifikációs elemzés a pszeudonimizációs dossziéban.)

## 6. A jogász által megjelölendő nyitott pont (a draftból)
A "Share a Cart" linkre kattintó személy (akinek nincs előzetes kapcsolata a
Merchanttal) jellemzése: a kattintási adata a Merchantot teszi-e adatkezelővé
(dokumentált utasításra), vagy a peci-t önálló/közös adatkezelővé saját Art.13/26
tájékoztatási és DSR-kötelezettséggel. A draft adatfeldolgozó-Merchant-utasítás
alapon kezeli; ezt adatvédelmi ügyvédnek kell megerősítenie.
