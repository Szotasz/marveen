// Push the 19 weekly-meeting Fathom summaries into a Notion page (one child page per meeting).
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const NT = JSON.parse(readFileSync("/root/marveen/agents/irnok/.claude/settings.json","utf8")).env.NOTION_TOKEN;
const PARENT = "351b5814-88c4-80df-9641-e275a23d1897"; // Fathom jegyzetek (belso, public_url: None) - Attila keszitette 2026-06-26
const NV = "2022-06-28";
const data = JSON.parse(readFileSync("/root/marveen/store/fathom-heti-elemzesek.json","utf8"));

const api = async (method, path, body) => {
  const r = await fetch("https://api.notion.com/v1"+path, {
    method, headers: { "Authorization":"Bearer "+NT, "Notion-Version":NV, "Content-Type":"application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${JSON.stringify(j).slice(0,200)}`);
  return j;
};
const rt = (s) => [{ type:"text", text:{ content: String(s).slice(0,1990) } }];
const mdToBlocks = (md) => {
  const blocks = [];
  for (let raw of md.split("\n")) {
    const line = raw.replace(/\*\*/g,"").replace(/^\s*[-*]\s+/,m=>m).trimEnd();
    if (!line.trim()) continue;
    let t = line.trim();
    if (t.startsWith("#### ")) blocks.push({heading_3:{rich_text:rt(t.slice(5))}});
    else if (t.startsWith("### ")) blocks.push({heading_3:{rich_text:rt(t.slice(4))}});
    else if (t.startsWith("## ")) blocks.push({heading_2:{rich_text:rt(t.slice(3))}});
    else if (t.startsWith("# ")) blocks.push({heading_2:{rich_text:rt(t.slice(2))}});
    else if (/^[-*]\s+/.test(t)) blocks.push({bulleted_list_item:{rich_text:rt(t.replace(/^[-*]\s+/,""))}});
    else if (/^\d+\.\s+/.test(t)) blocks.push({numbered_list_item:{rich_text:rt(t.replace(/^\d+\.\s+/,""))}});
    else blocks.push({paragraph:{rich_text:rt(t)}});
    blocks[blocks.length-1].object="block";
    blocks[blocks.length-1].type=Object.keys(blocks[blocks.length-1]).find(k=>k!=="object"&&k!=="type");
  }
  return blocks;
};

// 0) archive the old nested container if present (so it is not duplicated)
const OLD_CONTAINER = "38bb5814-88c4-81cc-bcf3-fc4ab117597c";
try { await api("PATCH","/pages/"+OLD_CONTAINER,{ archived:true }); console.log("regi container archivalva"); } catch(e){ console.log("container archive skip:", e.message.slice(0,80)); }

// 1) intro blocks appended DIRECTLY to the Fathom jegyzetek page (no extra nesting)
await api("PATCH","/blocks/"+PARENT+"/children",{ children:[
  {object:"block",type:"heading_2",heading_2:{rich_text:rt("📊 Heti meeting elemzések (Fathom) — első kör")}},
  {object:"block",type:"paragraph",paragraph:{rich_text:rt("Automatikus feldolgozás a Fathom felvételekből (heti üzletági megbeszélések + OKR review-k, 2026-02-27 .. 2026-06-26). Minden meeting külön aloldalon, a Fathom strukturált összefoglalójával. Készítette: Boss, később profin kidolgozandó.")}},
]});
const parentPage = { id: PARENT, url: "https://app.notion.com/p/"+PARENT.replace(/-/g,"") };
console.log("Meetingek KOZVETLENUL a Fathom jegyzetek ala kerulnek:", PARENT);

// 2) per-meeting child pages
let ok=0, skip=0;
for (const m of data) {
  if ((m.summary_md||"").length < 100) { console.log("SKIP (nincs summary):", m.date, m.title); skip++; continue; }
  const dstr = (m.date||"").slice(0,10);
  const inv = (m.invitees||[]).join(", ");
  let blocks = mdToBlocks(m.summary_md);
  const header = [
    {object:"block",type:"paragraph",paragraph:{rich_text:rt("Dátum: "+dstr+"  |  Résztvevők ("+(m.invitees||[]).length+"): "+inv)}},
    {object:"block",type:"paragraph",paragraph:{rich_text:[{type:"text",text:{content:"Fathom felvétel", link:{url:m.url}}}]}},
    {object:"block",type:"divider",divider:{}},
  ];
  let all = header.concat(blocks);
  const first = all.slice(0,100);
  const child = await api("POST","/pages",{
    parent:{ page_id: parentPage.id },
    properties:{ title:{ title: rt(dstr+" — "+m.title) } },
    children: first,
  });
  let rest = all.slice(100);
  while (rest.length) {
    await api("PATCH","/blocks/"+child.id+"/children",{ children: rest.slice(0,100) });
    rest = rest.slice(100);
    await new Promise(r=>setTimeout(r,350));
  }
  ok++;
  console.log("OK:", dstr, m.title.slice(0,30), "blokk:", all.length);
  await new Promise(r=>setTimeout(r,350));
}
console.log(`\nKESZ. Letrehozott aloldal: ${ok}, kihagyott: ${skip}`);
console.log("PARENT URL:", parentPage.url);
