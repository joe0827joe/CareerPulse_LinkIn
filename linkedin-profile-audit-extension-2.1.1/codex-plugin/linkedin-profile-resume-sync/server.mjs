import http from 'node:http';
import readline from 'node:readline';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const root=dirname(fileURLToPath(import.meta.url));
// A packaged plugin cannot assume its source checkout is the user's resume
// workspace.  The optional environment value is only a convenience for a
// local developer; normal callers configure an explicit workspace first.
let workspace=process.env.LINKEDIN_RESUME_WORKSPACE || null;
let sessionContract=null;
const bridgePort=Number(process.env.LINKEDIN_RESUME_PORT || 37841);
const queue=[];
const inFlight=new Set();
const results=new Map();
let lastSeen=null;
let sequence=0;
const waiters=new Map();
// Do not grant arbitrary websites access to a privileged browser-automation
// queue. This is an origin restriction, NOT client authentication: another
// local process can forge an Origin header. Pairing/auth remains required for
// untrusted local machines.
const EXTENSION_ORIGIN=/^chrome-extension:\/\/[a-p]{32}$/;
const allowedExtensionId=process.env.LINKEDIN_RESUME_EXTENSION_ID || '';
if (allowedExtensionId && !/^[a-p]{32}$/.test(allowedExtensionId)) {
  throw new Error('LINKEDIN_RESUME_EXTENSION_ID must be a 32-character Chrome extension ID');
}
const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
function sendHttp(req,res,status,value,extra={}){
  const origin=req.headers.origin;
  const cors=origin && EXTENSION_ORIGIN.test(origin) && (!allowedExtensionId || origin===`chrome-extension://${allowedExtensionId}`)
    ? {'Access-Control-Allow-Origin':origin,'Vary':'Origin'} : {};
  res.writeHead(status,{...jsonHeaders,...cors,...extra});
  res.end(value==null?'':JSON.stringify(value));
}
function authorizedExtensionRequest(req){
  const origin=req.headers.origin || '';
  const host=req.headers.host || '';
  const actualPort=bridge.address()?.port;
  return EXTENSION_ORIGIN.test(origin)
    && (!allowedExtensionId || origin===`chrome-extension://${allowedExtensionId}`)
    && (host===`127.0.0.1:${actualPort}`);
}
function readBody(req){return new Promise((resolveBody,reject)=>{
  let body=''; let rejected=false;
  req.on('data',chunk=>{
    if(rejected)return;
    body+=chunk;
    if(Buffer.byteLength(body)>2_000_000){rejected=true;reject(new Error('body too large'));req.resume();}
  });
  req.on('end',()=>{if(rejected)return;try{resolveBody(JSON.parse(body||'{}'));}catch(error){reject(error);}});
  req.on('error',reject);
});}

const bridge=http.createServer(async(req,res)=>{
  try {
    if(!authorizedExtensionRequest(req)) return sendHttp(req,res,403,{error:'extension origin not allowed'});
    if(req.method==='OPTIONS') return sendHttp(req,res,204,null,{
      'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type',
    });
    if(req.method==='GET'&&req.url==='/health') return sendHttp(req,res,200,{ok:true,lastSeen,queued:queue.length});
    if(req.method==='GET'&&req.url==='/next'){
      lastSeen=new Date().toISOString();
      const command=queue.shift();
      if(command)inFlight.add(command.id);
      return command?sendHttp(req,res,200,command):sendHttp(req,res,204,null);
    }
    if(req.method==='POST'&&req.url==='/result'){
      const result=await readBody(req);
      if(!result || typeof result.id!=='string' || !inFlight.has(result.id) || typeof result.ok!=='boolean'){
        return sendHttp(req,res,409,{error:'unexpected or invalid command result'});
      }
      lastSeen=new Date().toISOString();
      results.set(result.id,result); inFlight.delete(result.id);
      const pending=waiters.get(result.id);
      if(pending){pending(result);waiters.delete(result.id);results.delete(result.id);}
      return sendHttp(req,res,200,{ok:true});
    }
    return sendHttp(req,res,404,{error:'not found'});
  } catch(error){return sendHttp(req,res,400,{error:String(error?.message||error)});}
});
bridge.listen(bridgePort,'127.0.0.1',()=>console.error(`[linkedin-resume-sync] bridge listening on 127.0.0.1:${bridge.address().port}`));

function enqueue(action,args={}){const id=`cmd-${Date.now()}-${++sequence}`;queue.push({id,action,args});return id;}
function waitResult(id,timeoutMs=15000){
  if(results.has(id)){const result=results.get(id);results.delete(id);return Promise.resolve(result);}
  return new Promise(resolveWait=>{
    const timer=setTimeout(()=>{waiters.delete(id);resolveWait({id,ok:false,error:'timeout waiting for Edge extension'});},Math.min(Math.max(timeoutMs,100),30000));
    waiters.set(id,value=>{clearTimeout(timer);resolveWait(value);});
  });
}
const text=value=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value,null,2)}]});

const COMMAND_CONTRACT_VERSION='1.0';
const sha256=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function configureWorkspace(path){
  if(typeof path!=='string' || !path.trim()) throw new Error('workspacePath 必須是包含履歷契約的絕對資料夾路徑');
  const candidate=resolve(path);
  const required=[resolve(candidate,'contracts','linkedin-profile-sync-contract.json'),resolve(candidate,'linkedin-profile-audit-extension-2.1.1','profile-targets.json')];
  await Promise.all(required.map(file=>stat(file)));
  workspace=candidate;
  return {configured:true,workspace};
}
function requireWorkspace(){
  if(!workspace) throw new Error('尚未設定履歷工作區；先呼叫 configure_workspace 並提供含 contracts/ 的資料夾路徑');
  return workspace;
}

function expectedExtensionTargets(contract){
  const targets={}, operations={};
  for(const locale of contract.locales||[]) { targets[locale]={}; operations[locale]=[]; }
  for(const operation of contract.operations||[]){
    // Human-review-only items intentionally have no browser write operation.
    // They remain in the source contract for the review checklist, but not in
    // the generated extension command contract.
    if(operation.operation==='manual_review') continue;
    if(!targets[operation.locale]) continue;
    operations[operation.locale].push(Object.fromEntries(['id','section','operation','url','fields','field_mapping','identity'].filter(key=>key in operation).map(key=>[key,operation[key]])));
  }
  return {schema_version:'2.0',artifact_type:'linkedin_extension_targets',
    profile_url:contract.profile?.public_profile_url,shared_content_primary_locale:contract.shared_content_primary_locale,
    shared_content_operation_ids:contract.shared_content_operation_ids,targets,operations};
}

function validateSessionContract(contract) {
  if (!contract || !/^https:\/\/www\.linkedin\.com\/in\/[^/?#]+\/$/.test(contract.profile?.public_profile_url || '')) throw new Error('Provide a canonical LinkedIn profile URL ending in /');
  if (!Array.isArray(contract.locales) || !contract.locales.length || contract.locales.some(x=>! /^[a-z]{2}_[A-Z]{2}$/.test(x))) throw new Error('Provide valid locales');
  if (!Array.isArray(contract.operations)) throw new Error('operations must be an array; an empty discovery plan is allowed');
  const ids=new Set();
  for (const op of contract.operations) {
    if (!/^[a-z][a-z0-9_]*$/.test(op.id) || ids.has(`${op.locale}:${op.id}`)) throw new Error('Invalid or duplicate operation ID');
    ids.add(`${op.locale}:${op.id}`);
    if (!contract.locales.includes(op.locale) || !/^[a-z][a-z0-9_]*$/.test(op.section) || !['create','replace'].includes(op.operation)) throw new Error('Invalid operation locale, section or type');
    const inProfile=value=>typeof value==='string' && value.startsWith(contract.profile.public_profile_url) && new URL(value).origin==='https://www.linkedin.com' && new URL(value).pathname.startsWith(new URL(contract.profile.public_profile_url).pathname);
    if (!inProfile(op.url)) throw new Error('Operation URL must belong to the selected profile');
    if (!op.fields || Array.isArray(op.fields) || !Object.keys(op.fields).length) throw new Error('Operation needs fields');
    for (const [field,value] of Object.entries(op.fields)) {
      const scalar=['string','number','boolean'].includes(typeof value);
      const multiSelect=Array.isArray(value) && value.length>0 && value.every(item=>['string','number'].includes(typeof item));
      if (!scalar && !multiSelect) throw new Error('Unsupported field value');
      const mapping=op.field_mapping?.[field];
      if (!mapping || !(typeof mapping.selector==='string' && mapping.selector.trim() || Array.isArray(mapping.labels) && mapping.labels.length && mapping.labels.every(x=>typeof x==='string' && x.trim()))) throw new Error(`Inspect and map field ${field} first`);
    }
    if (op.operation==='create' && (!inProfile(op.identity?.url) || !Array.isArray(op.identity?.required_text) || !op.identity.required_text.length || op.identity.required_text.some(x=>typeof x!=='string'||!x.trim()))) throw new Error('Create requires a visible identity check');
  }
  return {...contract,schema_version:'1.0',artifact_type:'linkedin_profile_sync_contract',shared_content_primary_locale:contract.shared_content_primary_locale || contract.locales[0],shared_content_operation_ids:contract.shared_content_operation_ids || [],restrictions:{visible_ui_only:true,direct_network_writes:false,automatic_delete:false}};
}

async function contractStatus(){
  if(sessionContract) return {healthy:true,source:'mcp_session',profile_url:sessionContract.profile.public_profile_url,locales:sessionContract.locales,contract_sha256:sha256(sessionContract)};
  const activeWorkspace=requireWorkspace();
  const [contract,targets]=await Promise.all([
    readFile(resolve(activeWorkspace,'contracts','linkedin-profile-sync-contract.json'),'utf8').then(JSON.parse),
    readFile(resolve(activeWorkspace,'linkedin-profile-audit-extension-2.1.1','profile-targets.json'),'utf8').then(JSON.parse)
  ]);
  const issues=[];
  if(contract.schema_version!=='1.0') issues.push('Unsupported contract schema version');
  if(contract.artifact_type!=='linkedin_profile_sync_contract') issues.push('Unexpected contract artifact type');
  if(!contract.restrictions?.visible_ui_only||contract.restrictions?.direct_network_writes!==false||contract.restrictions?.automatic_delete!==false) issues.push('UI-only safety restrictions are invalid');
  if(!/^https:\/\/www\.linkedin\.com\/in\/[^/]+\/?$/.test(contract.profile?.public_profile_url||'')) issues.push('Contract profile URL is invalid');
  if(typeof contract.shared_content_primary_locale!=='string' || !contract.shared_content_primary_locale) issues.push('Contract shared-content primary locale is invalid');
  if(!Array.isArray(contract.shared_content_operation_ids)||!contract.shared_content_operation_ids.length) issues.push('Contract shared-content operation IDs are invalid');
  const expected=expectedExtensionTargets(contract);
  if(JSON.stringify(expected)!==JSON.stringify(targets)) issues.push('profile-targets.json is stale; run pipeline/build_profile_contract.py');
  return {healthy:issues.length===0,issues,contract_sha256:sha256(contract),extension_targets_sha256:sha256(targets),locales:contract.locales||[],profile_url:contract.profile?.public_profile_url,shared_content_primary_locale:contract.shared_content_primary_locale,shared_content_operation_ids:contract.shared_content_operation_ids||[]};
}

const tools=[
  {name:'set_resume_plan',description:'Bind a profile and submit or replace the complete agent-authored resume plan for this session. No workspace, Python or generated file is required. Start with empty operations to inspect the profile; then submit mapped create/replace operations based on visible forms. This does not save LinkedIn changes. Retain the plan in conversation for reconnects.',inputSchema:{type:'object',required:['contract'],properties:{contract:{type:'object',required:['profile','locales','operations'],properties:{profile:{type:'object',required:['public_profile_url'],properties:{public_profile_url:{type:'string'}}},locales:{type:'array',items:{type:'string'}},operations:{type:'array',items:{type:'object'}}}}},additionalProperties:false}},
  {name:'bridge_status',description:'Check whether the companion Edge extension is polling the local bridge.',inputSchema:{type:'object',properties:{}}},
  {name:'workspace_status',description:'Report the configured resume workspace. A portable installation starts unconfigured; use configure_workspace before reading a contract or changing a profile.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'configure_workspace',description:'Set the local resume workspace for this MCP session. The folder must contain contracts/linkedin-profile-sync-contract.json and the generated extension profile-targets.json. This never contacts LinkedIn.',inputSchema:{type:'object',required:['workspacePath'],properties:{workspacePath:{type:'string',minLength:1}},additionalProperties:false}},
  {name:'contract_status',description:'Validate the local versioned data contract, generated extension targets, and UI-only restrictions before maintenance or a profile update.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'read_contract',description:'Read the complete portable LinkedIn resume-sync contract. Use this for generic operation IDs, create/replace plans, URLs, fields, evidence, and mappings.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'read_extension_targets',description:'Read the generated portable extension contract for every locale declared by the selected resume workspace.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'send_command',description:'Send a UI-only command to the companion extension. For create operations use check_operation_identity first; a create is blocked unless the visible identity check confirmed absence. Use preview_operation to compare the visible form with the approved target without saving. Then open_operation, inspect_current_form, apply_and_save_operation, and verify_operation. read_history and export_logger are read-only.',inputSchema:{type:'object',required:['action'],properties:{action:{type:'string',enum:['status','scan','inspect_page','activate_control','navigate','inspect_current_form','check_operation_identity','preview_operation','verify_operation','export_logger','read_history','open_operation','apply_operation','apply_and_save_operation']},locale:{type:'string'},section:{type:'string'},controlId:{type:'string',description:'Opaque control ID returned by inspect_page'},url:{type:'string',description:'Observed visible profile link for discovery navigation'},operationId:{type:'string',pattern:'^[a-z][a-z0-9_]*$'}},additionalProperties:false}},
  {name:'wait_result',description:'Wait for the Edge extension result for a previously sent command.',inputSchema:{type:'object',required:['commandId'],properties:{commandId:{type:'string'},timeoutMs:{type:'integer',minimum:100,maximum:30000}},additionalProperties:false}}
];

async function callTool(name,args={}){
  if(name==='set_resume_plan') { if(queue.length || inFlight.size || waiters.size) throw new Error('Finish pending commands before replacing the plan'); sessionContract=validateSessionContract(args.contract); return text({accepted:true,operations:sessionContract.operations.length,profile_url:sessionContract.profile.public_profile_url}); }
  if(name==='bridge_status')return text({bridgeListening:true,lastExtensionPoll:lastSeen,connected:!!lastSeen&&Date.now()-Date.parse(lastSeen)<5000,queued:queue.length});
  if(name==='workspace_status')return text({configured:!!workspace,workspace});
  if(name==='configure_workspace')return text(await configureWorkspace(args.workspacePath));
  if(name==='contract_status')return text(await contractStatus());
  if(name==='read_contract')return text(sessionContract || JSON.parse(await readFile(resolve(requireWorkspace(),'contracts','linkedin-profile-sync-contract.json'),'utf8')));
  if(name==='read_extension_targets')return text(sessionContract ? expectedExtensionTargets(sessionContract) : JSON.parse(await readFile(resolve(requireWorkspace(),'linkedin-profile-audit-extension-2.1.1','profile-targets.json'),'utf8')));
  if(name==='send_command'){
    // Accept legacy nested arguments so an older caller cannot silently lose its target.
    const {action,args:legacyArgs,...commandArgs}=args;
    const normalized={...(legacyArgs && typeof legacyArgs==='object' ? legacyArgs : {}),...commandArgs};
    if(sessionContract) normalized.contractTargets=expectedExtensionTargets(sessionContract);
    return text({commandId:enqueue(action,normalized),accepted:true,contractVersion:COMMAND_CONTRACT_VERSION});
  }
  if(name==='wait_result')return text(await waitResult(args.commandId,args.timeoutMs));
  throw new Error(`Unknown tool: ${name}`);
}

const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function respond(id,result,error){process.stdout.write(JSON.stringify(error?{jsonrpc:'2.0',id,error}:{jsonrpc:'2.0',id,result})+'\n');}
rl.on('line',async line=>{
  if(!line.trim())return;
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id==null)return;
  try{
    if(message.method==='initialize')respond(message.id,{protocolVersion:message.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'resume-contract-studio',version:'2.8.0'}});
    else if(message.method==='tools/list')respond(message.id,{tools});
    else if(message.method==='tools/call')respond(message.id,await callTool(message.params?.name,message.params?.arguments||{}));
    else if(message.method==='ping')respond(message.id,{});
    else respond(message.id,null,{code:-32601,message:'Method not found'});
  }catch(error){respond(message.id,null,{code:-32603,message:String(error?.message||error)});}
});
rl.on('close',()=>bridge.close(()=>process.exit(0)));
process.on('SIGINT',()=>bridge.close(()=>process.exit(0)));