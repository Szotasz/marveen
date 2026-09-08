# Egyéni model-providerek

> Lehetővé teszi, hogy nem-főágens ágensek bármilyen Anthropic Messages API-kompatibilis végponton fussanak, minden provider-specifikus kód nélkül, a dashboardból konfigurálva.

---

## Mit csinál ez a funkció?

Alapból az ágensek az Anthropic Cloud API-n, OpenRouter-en vagy helyi Ollama végponton futnak. Az egyéni provider funkció lehetővé teszi, hogy tetszőleges, a `/v1/messages` Anthropic Messages API-t megvalósító végpontot regisztrálj, és ágensekhez rendelj. Így pl. OpenRouter ingyenes tier, DeepSeek saját kulccsal, vagy bármilyen Anthropic-kompatibilis proxy egyszerűen bekonfigurálható.

**Fontos korlát:** csak az Anthropic Messages API (`/v1/messages`) kompatibilis végpontok működnek. Tiszta OpenAI végpont (`/v1/chat/completions`) esetén fordítóproxyt kell közé tenni. A gyakorlati megoldás erre a LiteLLM proxy -- lásd a dokumentáció végén az *OpenCode Go bekötése LiteLLM proxyval* szakaszt.

---

## Konfiguráció

### Providerek kezelése (Dashboard)

Beállítások > Provider-ok tab. Innen lehet:
- új providert létrehozni (Új provider gomb)
- meglévőt szerkeszteni (Szerkesztés gomb a sorban)
- törölni (Törlés gomb a sorban)

A provider-lista a `store/custom-providers.json` fájlban tárolódik.

### Provider mezők

| Mező | Leírás |
|------|--------|
| **Megjelenő név** | Ember-olvasható cím, ez jelenik meg a dashboard listákon (pl. "DeepSeek (saját kulcs)") |
| **Provider azonosító (belső név)** | Egyedi technikai azonosító, csak `a-z 0-9 _ -` karakterek. Ez a belső hivatkozási név -- **nem a modellazonosító**. A modellt az ágens szerkesztőjében adod meg. |
| **Base URL** | A végpont gyökér URL-je, `https://` vagy `http://localhost` formátumban. A rendszer ebbe az URL-be irányítja a `/v1/messages` hívásokat. Kötelező `https://`-t használni, kivéve localhost/127.x esetén. |
| **Auth header** | Hogyan kerüljön át a hitelesítési token: `x-api-key` = `ANTHROPIC_API_KEY` env (Anthropic stílusú végpontok), `Bearer` = `ANTHROPIC_AUTH_TOKEN` env (OpenRouter stb.), `none` = token nélkül (Ollama-szerű, a modell neve elegendő) |
| **Vault kulcs neve** | A hitelesítési token neve a Vault-ban (Beállítások > Vault tab). A token értéke sosem kerül a provider-konfigba, csak a vault-kulcs neve. `none` auth esetén üresen hagyható. |

### Ágens hozzárendelése providerhez

1. Nyisd meg az ágens szerkesztőjét (szerkesztőceruza ikon).
2. A **Modell** legördülőben válassz egy bejegyzést az "Egyéni providerek" csoportból (pl. "my-deepseek").
3. Az **Egyéni modell ID** mezőbe írd be a modell azonosítóját (pl. `deepseek-chat`). Ez a provider végpontjára kerül küldésre.
4. Mentés után az ágens következő indításakor az egyéni végpontot használja.

### store/custom-providers.json

```json
{
  "providers": [
    {
      "id": "my-deepseek",
      "label": "DeepSeek (saját kulcs)",
      "baseUrl": "https://api.deepseek.com/anthropic",
      "authHeader": "x-api-key",
      "vaultKey": "deepseek-api-key"
    }
  ]
}
```

Ez a fájl nem kerül be a gitbe (`.gitignore`).

---

## API végpontok (dashboard-only, nem föderált)

| Módszer | Végpont | Leírás |
|---------|---------|--------|
| `GET` | `/api/custom-providers` | Az összes provider listája |
| `POST` | `/api/custom-providers` | Létrehozás vagy frissítés (upsert az `id` alapján) |
| `GET` | `/api/custom-providers/:id` | Egy provider adatai |
| `DELETE` | `/api/custom-providers/:id` | Törlés |

Minden végpont Bearer tokenes hitelesítést igényel (`store/.dashboard-token`), és föderált peerek számára nem elérhető.

---

## Biztonsági megjegyzések

- A `baseUrl` erősen validálva van indításkor: tiltott shell-metakarakterek, kötelező `https://` (kivéve localhost), URL-parse ellenőrzés.
- A vault kulcsok értéke sosem kerül a provider-konfigba -- csak a kulcs neve tárolódik.
- Ha egy ágenshez beállított provider-id nem található a `store/custom-providers.json`-ban, az ágens indítása hibával leáll (csendes Ollama-fallback helyett).
- Modell azonosítóban csak `a-zA-Z0-9._/:+-` karakterek engedélyeztek, hogy megakadályozzuk a shell-injekciót az egyéni provider ágakban.

---

## OpenCode Go bekötése LiteLLM proxyval

Rövid útmutató: hogyan futtass ágenst az OpenCode Go előfizetés modelljein (pl. `deepseek-v4-flash`) egy LiteLLM proxyn keresztül.

**Miért kell proxy?** Az egyéni provider funkció csak az Anthropic Messages API-t (`/v1/messages`) fogadja, az OpenCode Go viszont OpenAI-stílusú (`/v1/chat/completions`). A LiteLLM proxy a kettő közé ékelődik: felfelé az OpenCode Go OpenAI-végpontjával beszél, lefelé pedig Anthropic-kompatibilis `/v1/messages`-t kínál az ágensnek.

```
ágens  --/v1/messages-->  LiteLLM proxy  --/v1/chat/completions-->  OpenCode Go
```

**1. LiteLLM proxy.** Telepíts egy LiteLLM proxyt (docker-compose). A proxy localhoston szolgál ki (pl. `http://127.0.0.1:4010`), a modelleket a `config.yaml` `model_list`-jében definiálod.

**2. OpenCode Go modell felvétele** a `model_list`-be (a `<...>` helyekre a saját fiókod adatai kerülnek):

```yaml
model_list:
  - model_name: deepseek-v4-flash
    litellm_params:
      model: openai/deepseek-v4-flash
      api_base: <OPENCODE_GO_BASE_URL>
      api_key: os.environ/OPENCODE_API_KEY
```

**3. LiteLLM regisztrálása egyéni providerként** (Dashboard > Provider-ok > Új provider): Base URL = a proxy gyökere (pl. `http://127.0.0.1:4010`); Auth header = `Bearer`; Vault kulcs neve = a LiteLLM `master_key`-t tartalmazó vault-kulcs.

**4. Ágenshez rendelés** (ágens szerkesztő): Modell = a LiteLLM provider; Egyéni modell ID = a `model_name` (pl. `deepseek-v4-flash`).

**5. Indítsd újra az ágenst** -- innentől az OpenCode Go modelljén fut.
