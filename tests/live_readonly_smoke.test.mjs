import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const serverFile=resolve(root,'linkedin-profile-audit-extension-2.1.1/codex-plugin/linkedin-profile-resume-sync/server.mjs');
const contentFile=resolve(root,'linkedin-profile-audit-extension-2.1.1/linkedin_profile_audit_v2.user.js');
const origin='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const profile='https://www.linkedin.com/in/synthetic-test-profile/';
const plan={profile:{public_profile_url:profile},locales:['en_US'],operations:[]};

async function startClient(){
  const proc=spawn(process.execPath,[serverFile],{env:{...process.env,LINKEDIN_RESUME_PORT:'0',LINKEDIN_RESUME_WORKSPACE:''},stdio:['pipe','pipe','pipe']});
  const pending=new Map();
  let seq=0;
  createInterface({input:proc.stdout}).on('line',line=>{
    try{const res=JSON.parse(line);pending.get(res.id)?.(res);pending.delete(res.id)}catch{}
  });
  let port;
  const ready=new Promise((resolveReady,rejectReady)=>{
    let stderr='';
    const timer=setTimeout(()=>rejectReady(new Error('bridge bind timeout: '+stderr.slice(0,250))),4000);
    proc.stderr.on('data',chunk=>{
      stderr+=chunk.toString();
      const match=stderr.match(/bridge listening on 127\.0\.0\.1:(\d+)/);
      if(match){clearTimeout(timer);port=Number(match[1]);resolveReady();}
    });
    proc.once('exit',code=>{clearTimeout(timer);rejectReady(new Error('MCP server exited '+code+' '+stderr.slice(0,400)))});
  });
  await ready;
  const request=async(name,args={})=>{
    const id=++seq;
    const res=new Promise((resolveResult,rejectResult)=>{
      const timeout=setTimeout(()=>{pending.delete(id);rejectResult(new Error('MCP request timed out: '+name))},35000);
      pending.set(id,data=>{clearTimeout(timeout);resolveResult(data)});
    });
    proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\n');
    const response=await res;
    if(response.error)throw new Error(response.error.message);
    return JSON.parse(response.result.content[0].text);
  };
  return {port,request,async close(){proc.stdin.end();const exited=new Promise(resolveExit=>proc.once('exit',resolveExit));await Promise.race([exited,sleep(600).then(()=>proc.kill('SIGKILL'))]);}};
}

async function pair(client){
  const challenge=await client.request('begin_bridge_pairing');
  const response=await fetch(`http://127.0.0.1:${client.port}/pair`,{
    method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({pairingCode:challenge.pairingCode})
  });
  assert.equal(response.status,200);
  const value=await response.json();
  assert.equal(typeof value.token,'string');
  return {'X-Bridge-Token':value.token,Origin:origin};
}

async function emulateExtension(client,headers,makeResult){
  const actions=[];
  let running=true;
  const base=`http://127.0.0.1:${client.port}`;
  const loop=(async()=>{
    while(running){
      const response=await fetch(`${base}/next`,{headers});
      if(response.status===204){await sleep(12);continue;}
      assert.equal(response.status,200);
      const command=await response.json();
      actions.push(command.action);
      const result=makeResult(command,actions.length);
      const posted=await fetch(`${base}/result`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id:command.id,ok:true,result})});
      assert.equal(posted.status,200);
    }
  })();
  return {actions,async stop(){running=false;await loop;}};
}

function fakeResult(command,index,mode){
  const action=command.action;
  if(action==='read_history')return {status:'ok',profile,change_history:index===5 && mode==='historyChanged'?[{action:'unexpected'}]:[],form_inspections:[],operation_verifications:[]};
  if(action==='status')return {status:'ready',url:mode==='wrongProfile'?'https://www.linkedin.com/in/another-person/':profile,locale:'en_US',snapshot:{}};
  if(action==='scan')return {status:'scanned',snapshot:{source_url:profile},visible_text:'Synthetic LinkedIn page',links:[]};
  if(action==='inspect_page')return {url:profile,controls:[{controlId:'synthetic-control',label:'About'}],fields:[]};
  throw new Error('Unexpected write / navigation command: '+action);
}

for(const [scenario,expected] of [['success','PASS'],['historyChanged','FAIL'],['wrongProfile','FAIL']]){
  test(`read_only_smoke ${scenario} on real MCP -> loopback bridge`,{timeout:20000},async()=>{
    const client=await startClient();
    let extension;
    try{
      assert.equal((await client.request('set_resume_plan',{contract:plan})).accepted,true);
      const headers=await pair(client);
      extension=await emulateExtension(client,headers,(command,index)=>fakeResult(command,index,scenario));
      const result=await client.request('read_only_smoke',{timeoutMs:2500});
      assert.equal(result.result,expected);
      if(expected==='PASS'){
        assert.equal(result.checks.length,5);
        assert.equal(result.writeCommandsSent,0);
        assert.equal(result.checks.find(c=>c.action==='inspect_page').visibleControls,1);
      }else assert.ok(result.reason);
      assert.ok(extension.actions.every(a=>['read_history','status','scan','inspect_page'].includes(a)));
      if(scenario==='success')assert.deepEqual(extension.actions,['read_history','status','scan','inspect_page','read_history']);
    }finally{if(extension)await extension.stop();await client.close();}
  });
}

test('read_only_smoke requires an empty operation plan and pairing',async()=>{
  const client=await startClient();
  try{
    await assert.rejects(()=>client.request('read_only_smoke'),/Set a session plan/);
    await client.request('set_resume_plan',{contract:plan});
    await assert.rejects(()=>client.request('read_only_smoke'),/Pair the browser extension/);
  }finally{await client.close();}
});

test('write approval rejects absent, unselected, or stale-plan selection',()=>{
  const source=readFileSync(contentFile,'utf8');
  const reviewStart=source.indexOf('  const reviewSelection = locale => {');
  const reviewEnd=source.indexOf('\n  };',reviewStart)+6;
  const gateStart=source.indexOf('  const requireSelectedForApply = operationId => {');
  const gateEnd=source.indexOf('\n  };',gateStart)+6;
  assert.ok(reviewStart>0 && reviewEnd>reviewStart && gateStart>0 && gateEnd>gateStart);
  const current=[{id:'about',fields:{headline:'new'}}];
  const OPERATIONS={en_US:current};
  const localeKey=()=> 'en_US';
  const evaluate=state=>{
    const load=()=>state;
    const run=new Function('load','OPERATIONS','localeKey',`${source.slice(reviewStart,reviewEnd)}\n${source.slice(gateStart,gateEnd)}\nreturn requireSelectedForApply;`);
    return run(load,OPERATIONS,localeKey);
  };
  assert.throws(()=>evaluate({})('about'),/明確選取/);
  assert.throws(()=>evaluate({review_selection:{en_US:['about']}})('about'),/明確選取/);
  assert.throws(()=>evaluate({review_plan:{en_US:'old plan'},review_selection:{en_US:['about']}})('about'),/明確選取/);
  const fresh={review_plan:{en_US:JSON.stringify(current)},review_selection:{en_US:['about']}};
  assert.doesNotThrow(()=>evaluate(fresh)('about'));
  assert.throws(()=>evaluate(fresh)('education'),/明確選取/);
  assert.match(source,/new Set\(reviewSelection\(locale\) \?\? \[\]\)/);
});
