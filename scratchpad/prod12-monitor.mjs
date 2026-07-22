const GH=process.env.GH, REPO=process.env.REPO;
const gh=(u)=>fetch("https://api.github.com/repos/"+REPO+u,{headers:{Authorization:"token "+GH}}).then(r=>r.json());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let run=null;
for(let i=1;i<=36;i++){
  const d=await gh("/actions/workflows/deploy-prod.yml/runs?per_page=3");
  run=(d.workflow_runs||[])[0];
  console.log(`[${i*10}s] deploy-prod: ${run?run.status+"/"+run.conclusion:"none"} sha=${run?run.head_sha.slice(0,7):"-"}`);
  if(run&&run.status==="completed"){console.log("DONE:",run.conclusion,run.html_url);break;}
  await sleep(10000);
}
if(run&&run.conclusion==="success"){
  // verify endpoint live on prod (no-token -> 401 not 404)
  const r=await fetch("https://app.innoworx.hu/api/nova_bridge.php?action=create",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  console.log("PROD ?action=create (no-token) ->",r.status,"(401=el+vedve, 404=nincs)");
  console.log(r.status===401||r.status===400||r.status===422?"ENDPOINT LIVE ON PROD":"ENDPOINT CHECK");
}
