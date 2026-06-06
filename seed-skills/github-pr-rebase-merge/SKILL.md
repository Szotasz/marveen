---
name: github-pr-rebase-merge
description: Merge a stack of GitHub PRs sequentially when they share files and will cause cascading conflicts. Triggers when user says "merge the PRs sorban" or similar, and the PRs come from external forks (cannot push back to PR branch).
---

# GitHub PR rebase + merge for conflicting fork PRs

## Mikor használd

- 2+ nyitott PR ugyanazon a repo-n, ami átfed fájlokon (pl. `src/web.ts`)
- A PR-ok EXTERNAL forkból jönnek (head ref: `someuser:branch`), nem a saját repóból
- User azt kéri, hogy sorban mergeld mindet
- Nem tudsz pusholni a PR branch-ére (nincs write access a forkhoz)

## Az alap probléma

Ha két PR (`A`, `B`) ugyanazt a fájlt módosítja, az egyik merge után a másik CONFLICTING lesz a GitHub UI-ban, és `gh pr merge B` elbukik. Külső forkhoz nem tudsz force-pusholni egy rebaselt változatot, szóval két opció marad:

1. A szerző rebaselje manuálisan és pusholja (lassú, emberfüggő)
2. **Lokálisan rebaseled, majd squash-mergeled main-be, és a PR-t manuálisan close-olod** -- ez a skill

## Eljárás

### 1. Ellenőrzés és tiszta mergek (no conflict)

```bash
gh pr view <N> --json mergeable,mergeStateStatus
# MERGEABLE + CLEAN -> gh pr merge N --squash --delete-branch
# UNKNOWN -> várj 5-10 mp-et és újra kérdezd le (GitHub lazy-resolve)
# DIRTY + CONFLICTING -> menj a konfliktus-útra
```

Mindegyik merge után:
```bash
git pull --ff-only origin main
sleep 8  # GitHub időt igényel a mergeable status újraszámolására
```

### 2. Konfliktus út (rebase + manual merge)

```bash
# 1. Húzd le a PR-t lokális tracking branch-re
gh pr checkout <N>

# 2. Rebaseld main-re
git rebase main
# Konfliktus lesz. Rendezd a markereket (<<<<<<< / ======= / >>>>>>>)
# Tipikus eset: két branch új importot adott ugyanahhoz az import blokkhoz -- mindkettőt tartsd meg
# Tipikus eset: komment blokkok -- kombináld őket egy új kommentbe
# Tipikus eset: ugyanazt a függvényt módosítják más célból -- olvasd mindkettőt és integráld

git add <rendezett fájlok>
git rebase --continue

# 3. Lokálisan teszteld
npm run typecheck
npx vitest run

# 4. Próbáld pusholni a PR branch-re
git push --force-with-lease
# Ha "rejected (stale info)" vagy "remote rejected" -> nincs write access, menj a 5. pontra
```

### 3. Ha nincs push access (fork scenario)

```bash
# Checkoutold main-re, squash-mergeld a rebaselt branchet
git checkout main
git merge --squash <rebaselt-branch-név>

# Commitold co-author-ral
git commit -m "$(cat <<'EOF'
<eredeti PR title> (#N)

Rebased and merged manually due to conflict with <prior PR or series>.

Co-authored-by: <szerző> <szerző-email>
EOF
)"

git push origin main

# Zárd a PR-t manuálisan
gh pr close N --comment "Merged manually via rebase due to conflict with <prior PR>. See <commit-sha> on main." --delete-branch
```

## Buktatók

- **`gh pr merge` nem elég, ha CONFLICTING.** Ne próbálkozz vele, mert `--merge` vagy `--rebase` flag se oldja meg, ha a patch egyszerűen nem applikál. Menj egyenesen a lokális rebaselésre.
- **`gh pr checkout N` után a branch név a PR head ref-je**, pl. `v3-07-mcp-state-detection`. Ne tévesszen meg, hogy lokális branchként jelenik meg. Push-kor az `origin` a FORK URL-je (`<owner>/<repo>.git`), nem a saját origin.
- **"Skipped deleting the remote branch of a fork"** üzenet normális `gh pr close --delete-branch`-nál. Csak a lokális branchet törli.
- **GitHub `mergeStateStatus: UNKNOWN`** átmeneti állapot, ~5-15 másodperc alatt konszolidálódik. Ne legyél türelmetlen, várj.
- **Ha több sorszám-szám-csúsztatás konfliktus van egy fájlban** (pl. 3-4 marker blokk), szemantikusan oldd meg, nem csak mechanikusan. Olvasd fel a környező kódot és gondold át, mit próbál mindkét verzió csinálni.
- **A `co-authored-by` fontosság**: GitHub így még mindig hozzárendeli a szerzőnek a commitot, és a PR-ra "closed" státuszt rak, nem "merged"-et, de a kód bent van.
- **Miután pusholtál main-re, a TÖBBI nyitott PR state UNKNOWN -> CLEAN vagy DIRTY lesz.** Mindegyiknél újra kell nézni a státuszt merge előtt, mert lehet hogy a frissen mergelt commit új konfliktust generált.
- **`--delete-branch` flag a stacked PR-eket ZÁRJA, NEM CLOSE-olja.** Ha a PR base branch-e egy MÁSIK feat-branch (pl. a PR base = feat/slack-channel-request-workflow), és a parent PR-t `gh pr merge ... --delete-branch`-csel mergeled, a base törlődik és a child PR `state=CLOSED` lesz automatikusan -- ÉS `gh pr reopen` "Cannot open the pull request" hibát ad ÉS `gh pr edit --base main` "Cannot change the base branch of a closed pull request"-ot. Megoldás: új PR-t nyitni ugyanabból a head branchből (`gh pr create --base main --head <branch>`). A korábbi review-history a régi PR-on marad — link-eld be hivatkozással ("Re-opened after the prior PR closed when its base branch was deleted").
- **Az orchestrator-install branch-stuck**: az orchestrator agent lokál git checkout-ja a rebase-conflict resolution közben véletlenül a feat-branchen ragad (pl. `tmp-pr-rebase`-ből `git push origin tmp:feat/X --force` után a checkout helyben marad). Az update.sh `Guard 1: refuse non-main branch` ezt megfogja, és az `update.sh` exit-el — de a dashboard UI `pending commits`-ot listáz, és a "Frissítés most" gomb úgy tűnik mintha "legfrissebb verzión" lennél. Diagnózis: `git -C <project-root> branch --show-current`. Megoldás: `git stash push -u`, `git checkout main`, `git pull --ff-only`, `git stash pop`. Build+restart aztán.

- **A `npm run build && stop && start && stash pop` chain SIGKILL/exit-137 OOM.** A merge utáni manuális update-flow-t NE chain-eld egy shell-hívásba (a tsc build memóriafogyasztó, és a chain alatt a memória gyűlik → exit 137, build befejezetlen, services down). Helyes: minden lépés KÜLÖN hívásban (1: build, 2: stop, 3: start, 4: stash pop). A canonical út amúgy az `update.sh`, ami helyesen sorban csinálja.

- **A `stop.sh` UNLOAD-olja a launchd jobot → a KeepAlive NEM hozza vissza automatikusan.** A `com.<slug>.dashboard.plist`-ben `KeepAlive=true`, DE a `stop.sh` `launchctl unload`-dal áll le. Az unload SZÁNDÉKOS leállítás, a KeepAlive csak CRASH-re indít újra, unload-ra NEM. Ezért stop.sh után a fő-agent lent marad, amíg `launchctl load` (start.sh) vissza nem tölti. TANULSÁG: ha manuálisan `stop.sh`-zol update közben, MINDIG futtass utána `start.sh`-t magadtól, ne várj az operátorra. FONTOS: a `stop.sh` SZÁNDÉKOSAN NEM állítja le a sub-agenteket (csak a `${SLUG}-channels` fő-session-t — explicit komment a scriptben). Ha update után a sub-agentek mégis lent vannak, az NEM a stop.sh miatt van, vizsgáld külön; helyreállítás egyenként: `POST /api/agents/<name>/start` (Bearer token) + `tmux has-session -t agent-<name>` ellenőrzés.

## Ellenőrzés

- Minden PR után: `gh pr view <N> --json state,mergedAt` -> MERGED vagy CLOSED
- Végén: `gh pr list --limit 10` -> a listán ne legyen a mergelendő PR-ok egyike
- Végén: `npm run typecheck && npx vitest run` a friss main-en -> minden zöld
- Végén: `git log --oneline -10` -> minden PR commitja ott van a main-en

## Példa

Ha a user azt írja: "8 PR van, menj sorban, review és merge", és 3 egymás után konfliktál (mert mindegyik `src/web.ts`-t szerkeszti), az idő-becslés ~3-5 perc PR-onként konfliktussal, ~30 mp PR-onként clean merge-nél. Küldj progress update-et 50%-nál, hogy a user tudja haladsz.
