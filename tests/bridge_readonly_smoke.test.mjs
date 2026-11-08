// Offline synthetic smoke: actual stdio MCP server -> HTTP bridge -> MV3
// background script -> LinkedIn content script -> command result. No LinkedIn
// authentication, network requests to LinkedIn, or profile writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const extensionDir=resolve(projectRoot,'linkedin-profile-audit-extension-2.1.1');
const serverFile=resolve(extensionDir,'codex-plugin/linkedin-profile-resume-sync/server.mjs');
const PROFILE='https://www.linkedin.com/in/offline-smoke-user/';
const EXTENSION_ORIGIN=`chrome-extension://${'a'.repeat(32)}`;
const plan={profile:{public_profile_url:PROFILE},locales:['en_US'],operations:[]};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function freePort(){
  const s=createServer();
  await new Promise((ok,bad)=>s.once('error',bad).listen(0,'127.0.0.1',ok));
  const port=s.address().port;
  await new Promise(ok=>s.close(ok));
  return port;
}

function fakeElement(tag,props={}){
  const children=[];
  const el={tagName:tag.toUpperCase(), style:{cssText:''},children,
    textContent:props.textContent||'',innerText:props.innerText||'',
    id:props.id||'',href:props.href||'',disabled:false,isConnected:true,
    type:props.type||'',getClientRects:()=>[1],offsetHeight:20,offsetWidth:50,
    append(...nodes){children.push(...nodes);},
    appendChild(node){children.push(node);},
    remove(){this.isConnected=false;},
    getAttribute(key){return props[key]??null;},
    closest(){return null;},
    matches(){return false;}
  };
  return el;
}

function mockLinkedInDocument(){
  const experience=fakeElement('a',{innerText:'Experience',href:PROFILE+'details/experience/'});
  const edit=fakeElement('button',{innerText:'Edit profile'});
  const body=fakeElement('body',{innerText:'Synthetic fixture: Experience and About'});
  const document={
    readyState:'complete',body,
    getElementById:()=>null,
    querySelectorAll(selector){
      if(selector==='a[href],button,[role="button"],[role="tab"]')return [experience,edit];
      if(selector==='a[href]')return [experience];
      return [];
    },
    createElement(tag){return fakeElement(tag);},
    addEventListener(){},
  };
  return document;
}

async function startSyntheticBrowser(port){
  const store=new Map();
  let contentListener;
  const cDocument=mockLinkedInDocument();
  const contentChrome={runtime:{
    onMessage:{addListener(fn){contentListener=fn;}},
    async sendMessage(message){
      if(message.type==='readContractTargets')return {ok:false,error:'no static contract in smoke fixture'};
      return {ok:true};
    }
  }};
  const contentCtx={chrome:contentChrome,document:cDocument,
    location:{href:PROFILE,origin:'https://www.linkedin.com',pathname:'/in/offline-smoke-user/'},
    URL,Date,console,crypto:{randomUUID},localStorage:{
      getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)
    },
    setTimeout,clearTimeout,setInterval:()=>0};
  contentCtx.globalThis=contentCtx;
  const contentSource=await readFile(resolve(extensionDir,'linkedin_profile_audit_v2.user.js'),'utf8');
  runInNewContext(contentSource,contentCtx,{filename:'linkedin_profile_audit_v2.user.js'});
  assert.equal(typeof contentListener,'function','content script registered bridgeCommand handler');
  const tab={id:7,url:PROFILE,active:true,status:'complete'};
  const storage={session:{
    async get(key){return {[key]:store.get(`session:${key}`)};},
    async set(values){for(const [k,v] of Object.entries(values))store.set(`session:${k}`,v);},
    async remove(key){store.delete(`session:${key}`);}
  }};
  let backgroundListener;
  const listeners=[];
  const intervalHandles=[];
  const bChrome={storage,runtime:{id:'a'.repeat(32),
    getURL:()=> 'chrome-extension://'+('a'.repeat(32))+'/profile-targets.json',
    onStartup:{addListener(){}},
    onMessage:{addListener(fn){backgroundListener=fn;}},
    async sendMessage(message){
      return new Promise((resolveResponse,reject)=>{
        if(!backgroundListener)return reject(new Error('background listener not ready'));
        const accepted=backgroundListener(message,{id:'a'.repeat(32)},resolveResponse);
        if(accepted===false)resolveResponse({ok:true});
      });
    }
  },
    tabs:{
      async query(){return [tab];},
      async get(){return tab;},
      async create(){throw new Error('Unexpected tab creation in read-only smoke');},
      async sendMessage(tabId,message){
        assert.equal(tabId,7);
        assert.equal(message.type,'bridgeCommand');
        assert.ok(['status','scan','inspect_page','read_history'].includes(message.command.action),
          'smoke test must not perform LinkedIn writes');
        return await new Promise((accept,reject)=>{
          const result=contentListener(message,{},accept);
          if(result!==true)reject(new Error('content script refused the command'));
        });
      },
      onUpdated:{addListener(fn){listeners.push(fn);},removeListener(fn){const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);}}
    },
    scripting:{async executeScript(){throw new Error('Unexpected content script injection');}},
    downloads:{async download(){throw new Error('Unexpected download');}}
  };
  const fetchWithOrigin=(url,options={})=>{
    assert.ok(String(url).startsWith('http://127.0.0.1:37841/') || String(url).startsWith(`http://127.0.0.1:${port}/`),'no external network fetch');
    // Production extension uses the fixed local port; route to this test's ephemeral server.
    const actualUrl=String(url).replace('http://127.0.0.1:37841/',`http://127.0.0.1:${port}/`);
    return fetch(actualUrl,{...options,headers:{...options.headers,Origin:EXTENSION_ORIGIN}});
  };
  const backgroundCtx={chrome:bChrome,fetch:fetchWithOrigin,URL,Date,console,
    setTimeout,clearTimeout,setInterval(fn,ms){const t=setInterval(fn,ms);intervalHandles.push(t);return t;},
    clearInterval};
  backgroundCtx.globalThis=backgroundCtx;
  const backgroundSource=await readFile(resolve(extensionDir,'background.js'),'utf8');
  runInNewContext(backgroundSource,backgroundCtx,{filename:'background.js'});
  assert.equal(typeof backgroundListener,'function');
  return {storage,store,fetchWithOrigin,backgroundListener,stop(){intervalHandles.forEach(clearInterval);}};
}

function mcpClient(port){
  const child=spawn(process.execPath,[serverFile],{cwd:projectRoot,
    env:{...process.env,LINKEDIN_RESUME_PORT:String(port),LINKEDIN_RESUME_WORKSPACE:''},
    stdio:['pipe','pipe','pipe']});
  const pending=new Map();let nextId=1;let stderr='';
  child.stderr.on('data',x=>stderr+=x.toString());
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const reply=JSON.parse(line);const p=pending.get(reply.id);if(p){pending.delete(reply.id);p.resolve(reply);}}catch{}});
  child.on('exit',(code,signal)=>{for(const p of pending.values())p.reject(new Error(`MCP exited ${code}/${signal}: ${stderr}`));pending.clear();});
  return {
    child,
    async request(method,params={}){
      const id=nextId++;
      let timer;
      try{return await Promise.race([
        new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`MCP timeout on ${method}: ${stderr}`)),8000);})
      ]);}finally{clearTimeout(timer);pending.delete(id);}
    },
    async tool(name,args={}){
      const reply=await this.request('tools/call',{name,arguments:args});
      if(reply.error)throw new Error(JSON.stringify(reply.error));
      return JSON.parse(reply.result.content[0].text);
    },
    async stop(){lines.close();child.stdin.end();await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)]);if(child.exitCode===null)child.kill();}
  };
}

async function waitBridge(base){
  for(let attempt=0;attempt<60;attempt++){
    try{
      const response=await fetch(base+'/health',{headers:{Origin:EXTENSION_ORIGIN}});
      if(response.status===401)return;
    }catch{};
    await wait(50);
  }
  throw new Error('Bridge failed to start');
}

test('offline read-only full transport and pairing, without profile modification', {timeout:18000},async()=>{
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const client=mcpClient(port);
  let browser;
  try{
    await waitBridge(base);
    browser=await startSyntheticBrowser(port);
    assert.equal((await fetch(base+'/next',{headers:{Origin:EXTENSION_ORIGIN}})).status,401);
    assert.equal((await fetch(base+'/pair',{headers:{Origin:'https://untrusted.example'},method:'POST'})).status,403);
    const pair=await client.tool('begin_bridge_pairing');
    const response=await browser.fetchWithOrigin(base+'/pair',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:pair.pairingCode})
    });
    assert.equal(response.status,200);
    const paired=await response.json();
    await browser.storage.session.set({bridgeToken:paired.token});
    assert.equal((await client.tool('set_resume_plan',{contract:plan})).accepted,true);
    assert.equal((await client.tool('bridge_status')).paired,true);

    for(const action of ['status','scan','inspect_page','read_history']){
      const sent=await client.tool('send_command',{action});
      const completed=await client.tool('wait_result',{commandId:sent.commandId,timeoutMs:5000});
      assert.equal(completed.ok,true,JSON.stringify(completed));
      assert.equal(completed.id,sent.commandId);
      if(action==='status') assert.equal(completed.result.version,'4.13.0');
      if(action==='scan'){
        assert.equal(completed.result.status,'scanned');
        assert.ok(completed.result.links.some(x=>x.text==='Experience'));
      }
      if(action==='inspect_page'){
        assert.ok(completed.result.controls.some(x=>x.label==='Edit profile'));
      }
      if(action==='read_history')assert.deepEqual(JSON.parse(JSON.stringify(completed.result.change_history)),[]);
    }
    const ledger=browser.store.get('resume-contract-studio:offline-smoke-user:ledger:v1');
    const parsed=JSON.parse(ledger);
    assert.deepEqual(parsed.change_history??[],[],'read-only commands produced no change history');
    assert.equal((await client.tool('bridge_status')).paired,true);
    // A rotated challenge must immediately invalidate the previous bearer.
    const rotated=await client.tool('begin_bridge_pairing');
    const oldAccess=await browser.fetchWithOrigin(base+'/health',{headers:{'X-Bridge-Token':paired.token}});
    assert.equal(oldAccess.status,401);
    assert.equal((await client.tool('bridge_status')).paired,false);
    const badPair=await browser.fetchWithOrigin(base+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:'wrong'})});
    assert.equal(badPair.status,403);
    const repaired=await browser.fetchWithOrigin(base+'/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:rotated.pairingCode})});
    assert.equal(repaired.status,200);
    await browser.storage.session.set({bridgeToken:(await repaired.json()).token});
    assert.equal((await client.tool('bridge_status')).paired,true);
  }finally{browser?.stop();await client.stop();}
});