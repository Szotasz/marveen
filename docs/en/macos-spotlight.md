# macOS: the Spotlight index and "System Data"

## 🎯 What it means, why it matters

When Marveen runs on a Mac, the agents write all day: logs, jsonl transcripts (`~/.claude/projects`) and the sqlite database (`store/`). macOS Spotlight indexes these as well. With constant writes the index on the Data volume can grow to tens of GiB, and on every index merge macOS temporarily writes a full new copy on top.

In System Settings this shows up as growing **"System Data"** that partly disappears on a reboot.

One measured case (macOS 26.6, Mac mini):
- the index was 64+ GiB;
- one merge added another +74 GiB of temporary files;
- free space dropped to 28 GiB.

## Check

```bash
mdutil -s /System/Volumes/Data              # "Indexing enabled." = the index is running
bash scripts/doctor.sh                       # the "Spotlight (macOS)" section reports the same
```

The real index size and the merge files are visible to root only (asks for your password):

```bash
sudo du -sh /System/Volumes/Data/.Spotlight-V100
sudo lsof -c mds_stores | grep -iE 'merge|indexPositions'
```

## Fix (recommended)

**System Settings > Spotlight > Search Privacy**: add
1. the Marveen install folder (the one that holds `scripts/doctor.sh`; the doctor prints its exact path);
2. the `~/.claude` folder.

**The cost:** these two folders no longer show up in Cmd+Space search. You reach the logs, the jsonl and the database through the dashboard and the memory search anyway. Everything else (apps, documents, mail) stays searchable.

**What did NOT help in the measured case** (macOS 26.6):
- `mdutil` on a folder;
- a `.metadata_never_index` file in the folder.

Only the Search Privacy list did.

## Last resort

If the above is not enough, indexing of the whole Data volume can be switched off:

```bash
sudo mdutil -i off /System/Volumes/Data
```

This turns Spotlight search off for the **whole machine** (Cmd+Space, Finder search). To turn it back on: `sudo mdutil -i on /System/Volumes/Data`. The index is then rebuilt, which takes a while.

## 🛠 How it works

- On macOS, `scripts/doctor.sh` runs `scripts/lib/spotlight-check.sh`. When indexing is on for the Data volume, it warns, and shows the `mds_stores` CPU time and the root commands above.
- **Report only:** it never fails the run and changes nothing.
- It cannot read the Search Privacy list without root. If both folders are already on the list, the warning needs no action and can be ignored.
