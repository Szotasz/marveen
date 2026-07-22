import { readFileSync } from "node:fs";
const raw = readFileSync("/Users/macmini/marveen/agents/bit/.secrets/nova-dev-password.txt","utf-8").trim();
let pw = raw; try { const j = JSON.parse(raw); pw = j.password||j.NOVA_PASSWORD||j.value||raw; } catch {}
const base = "https://dev.innoworx.hu/api";
async function jwt(){ return (await (await fetch(base+"/auth_login.php",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"nova@innogroup.hu",password:pw})})).json()).token; }
const sleep = ms => new Promise(r=>setTimeout(r,ms));
for (let i=1;i<=18;i++){
  const token = await jwt();
  const H={Authorization:"Bearer "+token};
  const d = await (await fetch(base+"/tasks.php?my_tasks=1&include_completed=1",{headers:H})).json();
  const arr = Array.isArray(d)?d:(d.tasks||d.data||[]);
  const same = arr.filter(t => String(t.title||t.name||"")==="Nova ismétlődős pipálás teszt");
  const orig = same.find(t=>Number(t.id)===540);
  const spawn = same.filter(t=>Number(t.id)!==540 && t.status!=="done");
  console.log(`[${i*10}s] #540 status=${orig?.status} completed=${orig?.completed_at||"-"} | siblings=${same.length} | spawn=${spawn.map(t=>t.id+":"+t.status+":"+t.due_date).join(",")||"NONE"}`);
  if (spawn.length>0){ console.log("SPAWN CONFIRMED:", JSON.stringify(spawn.map(t=>({id:t.id,status:t.status,due:t.due_date,rtype:t.recurrence_type})))); process.exit(0); }
  if (orig?.status==="done" && i>=9){ console.log("orig done but no spawn yet after "+(i*10)+"s"); }
  await sleep(10000);
}
console.log("TIMEOUT: no spawn detected in 180s");
