const GH = process.env.GH, REPO = process.env.REPO;
import { readFileSync } from "node:fs";
const gh = (u) => fetch("https://api.github.com/repos/"+REPO+u,{headers:{Authorization:"token "+GH}}).then(r=>r.json());
const sleep = ms => new Promise(r=>setTimeout(r,ms));
// 1) find + poll the Deploy to Prod run for the merge
let run=null;
for (let i=1;i<=30;i++){
  const d = await gh("/actions/workflows/deploy-prod.yml/runs?per_page=5");
  run = (d.workflow_runs||[])[0];
  const st = run? `${run.status}/${run.conclusion}` : "no-run-yet";
  console.log(`[${i*10}s] deploy-prod: ${st} sha=${run?run.head_sha.slice(0,7):'-'} branch=${run?run.head_branch:'-'}`);
  if (run && run.status==="completed"){ console.log("DEPLOY DONE:", run.conclusion, run.html_url); break; }
  await sleep(10000);
}
if(!run||run.status!=="completed"){ console.log("deploy still running / not found after 300s"); process.exit(0); }
if(run.conclusion!=="success"){ console.log("DEPLOY NOT GREEN -> STOP, investigate:", run.html_url); process.exit(0); }
// 2) prod bridge verify
const raw=readFileSync("/Users/macmini/marveen/agents/bit/.secrets/nova-dev-password.txt","utf-8").trim();
let pw=raw; try{const j=JSON.parse(raw);pw=j.password||j.NOVA_PASSWORD||j.value||raw;}catch{}
const base="https://app.innoworx.hu/api";
// no-token GET -> expect 401
const noTok = await fetch(base+"/nova_bridge.php");
console.log("PROD bridge no-token GET ->", noTok.status, "(expect 401)");
// login as Nova on prod -> JWT
const lg = await fetch(base+"/auth_login.php",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"nova@innogroup.hu",password:pw})});
const lj = await lg.json().catch(()=>({}));
if(!lj.token){ console.log("PROD login FAILED", lg.status, JSON.stringify(lj).slice(0,150)); process.exit(0); }
console.log("PROD login OK: user", lj.user?.id, lj.user?.role);
const withTok = await fetch(base+"/nova_bridge.php",{headers:{Authorization:"Bearer "+lj.token}});
const body = await withTok.text();
let n="?"; try{const j=JSON.parse(body);const arr=Array.isArray(j)?j:(j.tasks||j.data||[]);n=arr.length;}catch{}
console.log("PROD bridge JWT GET ->", withTok.status, "(expect 200) | tasks:", n);
console.log(withTok.status===200 && noTok.status===401 ? "PROD VERIFY: PASS" : "PROD VERIFY: CHECK");
