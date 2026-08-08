# ComfyUI hobbi-guide (7900 XTX / ROCm) — Viktornak

Készült: 2026-08-08. A gép: air903max (Windows, a 7900 XTX-szel).
Kártya: #50.

## 0. Egyszer beállítandó (már megvan)
- A ComfyUI a 7900 XTX-en fut, mert az indításnál be van állítva a diszkrét
  kártya (a `--cuda-device 1` / `HIP_VISIBLE_DEVICES=1` miatt). Ha egyszer
  megint lassú lenne és az integrált APU-t választaná, ez a beállítás hiányzik.
- Nagy képgenerálás előtt az ollama modelljét érdemes kiütni a VRAM-ból, mert
  ugyanazt a kártyát használja. (Szólj, és kiütöm; vagy magától felszabadul.)

## 1. Hova kerül a letöltött modell (checkpoint)
A ComfyUI a checkpointokat EBBEN a mappában keresi (a te géped naplójából):

    C:\Users\remoteuser\AppData\Local\Comfy-Desktop\ComfyUI-Shared\models\checkpoints\

A letöltött `.safetensors` fájlt (pl. a Juggernaut XL) ide másold be. A
"ComfyUI-Shared" azért jó, mert minden ComfyUI-telepítésed innen látja a
modelleket, nem kell többször letölteni.

Fontos: teljes CHECKPOINT kell (SDXL alapmodell, ~6-7 GB), NE egy LoRA
(az kisebb, pár száz MB, és máshova, a `models\loras\` mappába megy).

## 2. Hogy jelenjen meg a ComfyUI-ban
1. Miután bemásoltad a fájlt a checkpoints mappába, a ComfyUI-ban a
   "Load Checkpoint" node legördülőjében jobb felül van egy frissítés (vagy
   nyomd meg az "R" billentyűt a vásznon) — utána megjelenik a modell.
2. Ha nem jön elő: a ComfyUI ablak jobb felső menüjéből "Restart", vagy
   app-újraindítás. Betöltéskor a napló is kiírja, hány checkpointot talált.

## 3. Juggernaut XL = SDXL modell → SDXL munkafolyamat
A Juggernaut XL egy SDXL-alapú modell, NEM SD3.5. Ezért NE az SD3.5 sablont
használd hozzá (az a 13 GB-os, lassabb, más felépítésű volt).

1. Hamburger ☰ > Workflow > Browse Templates > az "SDXL" (vagy sima
   "Image Generation" SDXL) sablont válaszd.
2. A "Load Checkpoint" node-ban válaszd ki a juggernautXL fájlt.
3. Ajánlott SDXL-beállítások az első próbához (a KSampler node-ban):
   - Felbontás (Empty Latent Image node): 1024 x 1024 (SDXL erre van tanítva;
     a 512 rontja a minőséget).
   - Steps: 25-30
   - CFG: 4-7 (Juggernautnál a 4-6 jellemzően jó)
   - Sampler: dpmpp_2m, Scheduler: karras (jó általános kiindulás)
4. Írj a pozitív prompt dobozba, a negatívba pl. "blurry, low quality,
   deformed", és nyomd meg a Run-t. SDXL-nél egy kép a 7900 XTX-en pár
   másodperc.

## 4. img2img — meglévő kép módosítása (amit "ingraph"-nak hívtál)
Igen, jól sejted: az img2img az a mód, ami egy MEGLÉVŐ képet alakít át, nem
nulláról generál. A logika: a bemeneti képet "latent"-té alakítod, és a
KSampler abból indul (nem üres vászonból), egy "denoise" (zajtalanítás)
erősséggel, ami eldönti, mennyire változzon.

Leggyorsabb út:
1. Hamburger ☰ > Workflow > Browse Templates > keresd az "img2img" sablont,
   töltsd be.
2. A "Load Image" node-ba húzd/tallózd be a módosítandó képet.
3. A KSampler node-ban a KULCS a "denoise" érték:
   - 0.3-0.5: enyhe változtatás (a kép nagyrészt megmarad, stílus/részlet
     finomítás).
   - 0.6-0.75: erős átalakítás (a kompozíció marad, de sok minden újragenerálódik).
   - 1.0: gyakorlatilag új kép (nem érdemes img2img-hez).
4. A prompt írja le, mit AKARSZ a végén; a checkpoint ugyanaz a Juggernaut XL.

## 5. Ahol a cenzúrázatlan modellek vannak
- Civitai (civitai.com): a legnagyobb gyűjtemény, SDXL-alapú modellek tömege,
  szűrők a NSFW tartalomra. A modell-oldalról a "Download" a teljes checkpoint.
- A letöltött fájl mindig a checkpoints mappába (2. pont), a LoRA-k a loras
  mappába.
- Figyeld a modell "Base Model" címkéjét: SDXL 1.0 = a fenti SDXL-sablon jó
  hozzá; ha "Pony" vagy "Illustrious", az is SDXL-leszármazott, ugyanígy megy,
  csak a promptolási stílusuk más (a modell-oldal leírja).

## Gyors hibaelhárítás
- Lassú (sok s/it): az integrált APU-ra esett vissza — nézd a napló "Device:"
  sorát, és a diszkrét kártyát kell kényszeríteni (0. pont).
- "model is missing": a checkpoint nincs a helyén vagy nem frissült a lista
  (2. pont).
- VRAM megtelik / kicsordul: az ollama modellje is a kártyán van — üttesd ki.
