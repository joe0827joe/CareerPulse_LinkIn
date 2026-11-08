// ==UserScript==
// @name         LinkedIn Profile Update, Audit & Logger
// @namespace    local.profile.patch
// @version      4.13.0
// @description  Applies the approved local bilingual target through visible LinkedIn forms and exports snapshots and change history. Never calls internal APIs.
// @match        https://www.linkedin.com/in/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
(() => {
  'use strict';
  // LinkedIn can expose a profile URL both with and without a trailing slash.
  // Treat both as the same visible profile so the bridge heartbeat is never
  // skipped merely because the browser used the canonical no-slash form.
  const PROFILE = location.pathname.match(/^\/in\/([^/]+)(?:\/|$)/)?.[1];
  if (!PROFILE) return;

  // No contract means no write capability: profile-specific content only comes
  // from the approved local contract supplied by the companion extension.
  let TARGETS = {};
  let targetSource = 'no_contract';
  let contractReady = false;
  let sharedContentPrimaryLocale = null;
  let sharedContentOperationIds = new Set();
  let OPERATIONS = {};
  let contractLocales = [];
  async function loadContractTargets(supplied) {
    contractReady=false;
    try {
      const response = supplied ? {ok:true,data:supplied} : await globalThis.chrome?.runtime?.sendMessage?.({type:'readContractTargets'});
      const data = response?.ok ? response.data : null;
      const targets = data?.schema_version === '2.0' && data?.artifact_type === 'linkedin_extension_targets' ? data.targets : null;
      const operations = data?.operations;
      const profile = new URL(data?.profile_url || '');
      if (!targets || !operations || !Object.values(operations).every(Array.isArray) || !Object.keys(operations).length || !Array.isArray(data?.shared_content_operation_ids) ||
          profile.origin !== location.origin || profile.pathname !== `/in/${PROFILE}/`) return false;
      TARGETS = targets;
      sharedContentPrimaryLocale = data.shared_content_primary_locale;
      sharedContentOperationIds = new Set(data.shared_content_operation_ids);
      OPERATIONS = operations;
      contractLocales = Object.keys(operations);
      targetSource = supplied ? 'mcp_session' : 'profile-targets.json';
      contractReady = true;
      return true;
    } catch (_) { /* No fallback: a missing or invalid contract disables writes. */ }
    return false;
  }
  const URLS = {
    overview: `/in/${PROFILE}/`, experience: `/in/${PROFILE}/details/experience/`,
    projects: `/in/${PROFILE}/details/projects/`, skills: `/in/${PROFILE}/details/skills/`
  };
  // Keep an auditable local ledger after the tab is closed. It is scoped to the
  // public profile slug and never leaves the browser unless the user exports it.
  const KEY = `resume-contract-studio:${PROFILE}:ledger:v1`;
  // LinkedIn uses short query values such as `language=en`, while a contract
  // uses BCP 47-style locale identifiers such as `en_US`.  Treat the short
  // value as an unambiguous language-family match before falling back to the
  // primary contract locale; otherwise an English form is incorrectly paired
  // with the Chinese operation list.
  const contractLocaleFor = requested => {
    if (!requested) return null;
    const normalized=requested.replace('-', '_');
    if (contractLocales.includes(normalized)) return normalized;
    const language=normalized.split('_')[0].toLowerCase();
    return contractLocales.find(locale => locale.split('_')[0].toLowerCase()===language) || null;
  };
  const requestedLocale = () => {
    const params=new URL(location.href).searchParams;
    return contractLocaleFor(params.get('locale') || params.get('language'));
  };
  const localeKey = () => requestedLocale() || contractLocales[0] || 'und';
  const localized = path => path;
  const clean = s => (s || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const pageText = () => clean(document.body?.innerText);
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
  function save(data) { localStorage.setItem(KEY, JSON.stringify(data)); }
  const reviewSelection = locale => {
    const record=load();
    // Approval is tied to the exact current operation mapping. If target fields
    // change, old choices must not authorize new writes under the same ID.
    const fingerprint=JSON.stringify(OPERATIONS[locale] || []);
    if(record.review_plan?.[locale] !== fingerprint) return null;
    const selected=record.review_selection?.[locale];
    return Array.isArray(selected) ? selected : null;
  };
  const saveReviewSelection = (locale, selected) => {
    const data=load(); data.review_selection ||= {}; data.review_selection[locale]=[...new Set(selected)]; save(data);
  };
  const requireSelectedForApply = operationId => {
    const selected=reviewSelection(localeKey());
    if (!selected || !selected.includes(operationId)) throw new Error('此操作尚未由使用者明確選取；請先在面板勾選');
  };
  const visible = el => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const editables = () => [...document.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable="true"],select')].filter(visible);
  const editableValue = el => el.matches('[contenteditable="true"]') ? clean(el.innerText) : clean(el.value);
  const fieldLabel = el => {
    const byFor=el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const container=el.closest('[data-test-form-element],.artdeco-text-input--container,fieldset');
    const local=container?.querySelector('label,[role="label"]');
    return clean(byFor?.innerText || local?.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder'));
  };
  const formSnapshot = () => editables().map(el => ({
    tag:el.tagName.toLowerCase(), type:el.type || null, aria:el.getAttribute('aria-label'),
    selector:el.id ? `#${CSS.escape(el.id)}` : null,
    options:el.tagName==='SELECT' ? [...el.options].map(o=>({value:o.value,text:clean(o.text)})) : undefined,
    multiple:el.tagName==='SELECT' ? !!el.multiple : undefined,
    supported:el.type !== 'file',
    placeholder:el.getAttribute('placeholder'), label:fieldLabel(el), value:editableValue(el),
    checked:el.type === 'checkbox' ? !!el.checked : undefined,
    selected_text:el.tagName === 'SELECT' ? clean(el.selectedOptions?.[0]?.text) : undefined
  }));
  function setValue(el, value, keepFocus=false) {
    if (!el) throw new Error('找不到目標欄位');
    el.focus();
    if (el.matches('[contenteditable="true"]')) {
      const selection=getSelection(), range=document.createRange(); range.selectNodeContents(el);
      selection.removeAllRanges(); selection.addRange(range);
      if (!document.execCommand('insertText', false, value)) {
        el.textContent=value;
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
      }
    } else {
      const proto=el.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value')?.set?.call(el,value);
      el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if (!keepFocus) el.blur();
  }
  const editor = () => [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible);
  function setSelectOption(el, wanted, aliases) {
    const option=[...el.options].find(item => aliases.some(alias => clean(item.text).toLowerCase() === alias.toLowerCase()));
    if (!option) throw new Error(`選單沒有核准值：${wanted}`);
    el.value=option.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function setMultiSelectOptions(el, wanted) {
    if (!Array.isArray(wanted) || !wanted.length) throw new Error('多選欄位必須提供非空文字或數字清單');
    const wantedValues=wanted.map(value=>clean(String(value)).toLowerCase());
    const options=[...el.options];
    const selected=options.filter(option=>wantedValues.includes(clean(option.text).toLowerCase()));
    if (selected.length!==wantedValues.length) throw new Error('多選清單沒有全部核准值');
    for (const option of options) option.selected=selected.includes(option);
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function setChecked(el, wanted) {
    if (!!el.checked !== wanted) { el.click(); }
  }
  const operationFor = id => OPERATIONS[localeKey()]?.find(operation => operation.id === id);
  const genericFieldPatterns = {
    text:[/headline|標題|標頭/i], position_title:[/title|職稱/i], organization:[/organization|company|組織|公司/i], skill:[/skill|技能/i],
    name:[/name|名稱/i], employment_type:[/employment type|工作類型/i], start_month:[/start month|開始月份/i],
    start_year:[/start year|開始年份/i], current_position:[/currently|目前擔任/i]
  };
  function genericControl(field, fieldMapping={}) {
    if (fieldMapping.selector) {
      const matches=editables().filter(el=>el.matches(fieldMapping.selector));
      if (matches.length !== 1) throw new Error(`資料契約 selector 對 ${field} 找到 ${matches.length} 個欄位；不會猜測`);
      return matches[0];
    }
    if (fieldMapping.labels?.length) {
      const labels=fieldMapping.labels.map(value=>clean(value).toLowerCase());
      const matches=editables().filter(el=>labels.includes(fieldLabel(el).toLowerCase()));
      if(matches.length!==1) throw new Error(`欄位 ${field} 的標籤必須唯一命中（${matches.length}）`);
      return matches[0];
    }
    if (field === 'description') { const matches=editables().filter(el=>el.matches('textarea,[contenteditable="true"]')); if(matches.length!==1) throw new Error('Description needs an explicit mapping'); return matches[0]; }
    const patterns=genericFieldPatterns[field];
    if (!patterns) throw new Error(`通用映射尚未支援欄位：${field}；請先 inspect_current_form 並在資料契約定義映射`);
    const selector=field === 'employment_type' || field === 'start_month' || field === 'start_year' ? 'select' :
      field === 'current_position' ? 'input[type="checkbox"]' : 'input[type="text"],input:not([type])';
    const matches=[...document.querySelectorAll(selector)].filter(visible).filter(element => {
      const label=`${fieldLabel(element)} ${element.getAttribute('placeholder') || ''}`;
      const contractLabels=(fieldMapping.labels || []).map(value => value.toLowerCase());
      return contractLabels.length ? contractLabels.some(value => label.toLowerCase().includes(value)) : patterns.some(pattern => pattern.test(label));
    });
    if (matches.length !== 1) throw new Error(`欄位 ${field} 映射不唯一或不存在（找到 ${matches.length} 個）；請先 inspect_current_form 並補充資料契約`);
    return matches[0];
  }
  function assertSupportedControl(field, control) {
    if (control.type === 'file') throw new Error(`欄位 ${field} 是檔案上傳；目前不會自動選取或上傳檔案`);
  }
  function genericSelectAliases(field, value) {

    return [String(value), `${value} 月`, `${value}月`];
  }
  async function selectSkill(control, value) {
    setValue(control,value,true); await sleep(700);
    const option=[...document.querySelectorAll('[role="option"]')].filter(visible).find(el => clean(el.innerText).split('\n')[0] === value);
    if (!option) throw new Error(`LinkedIn 沒有提供核准技能：${value}`);
    option.click(); control.blur(); await sleep(120);
  }
  async function applyOperation(operation, saveAfter=false) {
    if (!operation || !operation.fields || !operation.section) throw new Error('資料契約 operation 不完整');
    if (!['replace','create'].includes(operation.operation)) throw new Error('此 operation 不是可填寫的 LinkedIn 表單目標');
    if (operation.operation === 'create') {
      const preflight=load().identity_checks?.[operation.id];
      if (!preflight || preflight.exists !== false) throw new Error('建立前尚未確認此履歷項目不存在；先執行 check_operation_identity，避免重複新增');
    }
    // Resolve all declared controls before the first mutation, so an ambiguous
    // later mapping cannot leave an earlier field partially edited.
    for (const field of Object.keys(operation.fields)) {
      const control=genericControl(field,operation.field_mapping?.[field]);
      assertSupportedControl(field,control);
    }
    const before=formSnapshot(), applied=[];
    for (const [field,value] of Object.entries(operation.fields)) {
      const control=genericControl(field,operation.field_mapping?.[field]);
      if (field === 'description' || field === 'text') {
        assertContentLocale(editableValue(control), value, operation.id, operation.id);
        setValue(control,value);
      } else if (field === 'skill' || control.getAttribute('role') === 'combobox' || control.getAttribute('aria-autocomplete') === 'list') {
        if (typeof value !== 'string' || !value.trim()) throw new Error('skill 必須是非空文字');
        await selectSkill(control,value);
      } else if (field === 'current_position' || control.type === 'checkbox') {
        if (typeof value !== 'boolean') throw new Error(`${field} 必須為布林值`);
        setChecked(control,value);
      } else if (control.type === 'radio') {
        if (typeof value !== 'boolean') throw new Error(`${field} 的 radio 選項必須是布林值`);
        if (value) { if (!control.checked) control.click(); }
        else if (control.checked) throw new Error(`${field} 已選取；radio 不能單獨取消，請將 true 指定給同群組的目標選項`);
      } else if (control.tagName === 'SELECT' && control.multiple) {
        setMultiSelectOptions(control,value);
      } else if (['employment_type','start_month','start_year'].includes(field) || control.tagName === 'SELECT') {
        if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${field} 的選單值必須是文字或數字`);
        setSelectOption(control,value,genericSelectAliases(field,value));
      } else if (typeof value === 'string') {
        setValue(control,value);
      } else {
        throw new Error(`欄位 ${field} 的資料型別不支援`);
      }
      applied.push(field);
    }
    await sleep(100); const after=formSnapshot();
    if (saveAfter) {
      const button=saveButton();
      if (!button) throw new Error('已填入，但找不到儲存／Save 按鈕；不會宣告已儲存');
      button.click();
    }
    logChange({action:`operation:${operation.id}`,before,after,applied_fields:applied,save_requested:saveAfter,status:saveAfter?'save_clicked':'filled'});
    return {id:operation.id,section:operation.section,applied_fields:applied};
  }
  function assertContentLocale(existingValue, wanted, fieldName, operationId) {
    const existing=clean(existingValue);
    if (!existing) return;
    const targetIsChinese=/[\u4e00-\u9fff]/.test(wanted);
    const existingIsChinese=/[\u4e00-\u9fff]/.test(existing);
    // A non-primary language form can legitimately contain untranslated source
    // text.  Its explicit LinkedIn language URL is the authority for selecting
    // the locale, so permit the mapped operation to replace that stale text.
    const explicitlySelectedSecondaryLocale = !!requestedLocale() && localeKey() !== sharedContentPrimaryLocale;
    if (targetIsChinese !== existingIsChinese && !explicitlySelectedSecondaryLocale && (!sharedContentOperationIds.has(operationId) || localeKey() !== sharedContentPrimaryLocale)) {
      throw new Error(`目前${fieldName}內容語言與契約 locale 不符；不會覆寫另一語言版本`);
    }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
  const saveButton = () => [...document.querySelectorAll('button')].filter(visible)
    .find(button => ['儲存','Save'].includes(clean(button.innerText)));
  const logChange = entry => {
    const data=load(); data.change_history ||= [];
    data.change_history.push({at:new Date().toISOString(),locale:localeKey(),url:location.href,...entry});
    save(data);
  };
  const logFormInspection = fields => {
    // Inspections are strictly read-only evidence.  Keep a bounded local trail so
    // an exported Logger can reproduce field mapping without treating it as a
    // published-profile confirmation.
    const data=load(); data.form_inspections ||= [];
    data.form_inspections.push({at:new Date().toISOString(),locale:localeKey(),url:location.href,fields});
    data.form_inspections=data.form_inspections.slice(-20);
    save(data);
  };
  function readControlValue(control) {
    if (control.type === 'checkbox' || control.type === 'radio') return !!control.checked;
    if (control.tagName === 'SELECT') return control.multiple ? [...control.selectedOptions].map(option=>clean(option.text)) : clean(control.selectedOptions?.[0]?.text || control.value);
    return editableValue(control);
  }
  function valuesEqual(actual,wanted) {
    if (typeof wanted === 'boolean') return actual === wanted;
    const compact=value=>clean(String(value)).replace(/\s+/g,' ').toLowerCase();
    if (Array.isArray(wanted)) return Array.isArray(actual) && wanted.length===actual.length && wanted.every(value=>actual.some(item=>compact(item)===compact(value)));
    return compact(actual) === compact(wanted) || compact(actual) === compact(`${wanted} 月`);
  }
  function verifyOperation(operation) {
    if (!operation || !operation.fields) throw new Error('資料契約 operation 不完整');
    const checked=[], differences=[];
    for (const [field,wanted] of Object.entries(operation.fields)) {
      const actual=readControlValue(genericControl(field,operation.field_mapping?.[field]));
      const match=valuesEqual(actual,wanted);
      checked.push(field);
      if (!match) differences.push({field,expected:wanted,actual});
    }
    const result={at:new Date().toISOString(),locale:localeKey(),url:location.href,operationId:operation.id,checked_fields:checked,differences,verified:differences.length===0,verification_scope:'visible_form_only'};
    const data=load(); data.operation_verifications ||= []; data.operation_verifications.push(result); data.operation_verifications=data.operation_verifications.slice(-100); save(data);
    return result;
  }
  function previewOperation(operation) {
    if (!operation || !operation.fields) throw new Error('資料契約 operation 不完整');
    const preview=[];
    for (const [field,wanted] of Object.entries(operation.fields)) {
      const actual=readControlValue(genericControl(field,operation.field_mapping?.[field]));
      preview.push({field,before:actual,after:wanted,changed:!valuesEqual(actual,wanted)});
    }
    return {status:'preview_ready',operationId:operation.id,locale:localeKey(),url:location.href,preview,verification_scope:'visible_form_only',save_requested:false};
  }
  function checkOperationIdentity(operation) {
    if (!operation?.identity?.url || !Array.isArray(operation.identity.required_text)) throw new Error('create operation 必須在資料契約提供 identity.url 與 identity.required_text');
    const identityUrl=new URL(operation.identity.url);
    if (identityUrl.origin!==location.origin || !identityUrl.pathname.startsWith(`/in/${PROFILE}/`)) throw new Error('identity URL 不屬於目前契約個人檔案');
    if (identityUrl.pathname.replace(/\/$/,'') !== location.pathname.replace(/\/$/,'')) { location.href=operation.identity.url; return {status:'opening_identity_page',operationId:operation.id}; }
    const body=pageText(); const matched=operation.identity.required_text.filter(value=>body.includes(clean(value)));
    const result={at:new Date().toISOString(),url:location.href,required_text:operation.identity.required_text,matched,exists:matched.length===operation.identity.required_text.length};
    const data=load(); data.identity_checks ||= {}; data.identity_checks[operation.id]=result; save(data);
    return {status:'identity_checked',operationId:operation.id,...result};
  }
  let inspectedControls=new Map();
  let inspectedPageUrl=null;
  function inspectPage() {
    inspectedControls=new Map(); inspectedPageUrl=location.href;
    const controls=[...document.querySelectorAll('a[href],button,[role="button"],[role="tab"]')]
      .filter(visible).filter(el=>!el.closest('#li-audit-v2')).map(el=>{
        const id=globalThis.crypto.randomUUID();
        const label=clean(el.getAttribute('aria-label') || el.innerText);
        inspectedControls.set(id,{element:el,label});
        return {controlId:id,label,tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),url:el.tagName==='A'?el.href:null,disabled:!!el.disabled};
      });
    return {url:location.href,visible_text:pageText(),controls,fields:formSnapshot()};
  }
  function activateControl(id) {
    const entry=inspectedControls.get(id), el=entry?.element;
    if(inspectedPageUrl!==location.href || !el?.isConnected || !visible(el) || el.disabled || clean(el.getAttribute('aria-label') || el.innerText)!==entry.label) throw new Error('Control is stale; inspect_page again');
    if(el.tagName==='A' && !el.href.startsWith(`https://www.linkedin.com/in/${PROFILE}/`)) throw new Error('Link leaves the selected profile');
    if(/save|submit|publish|delete|remove|儲存|保存|提交|發佈|发布|刪除|删除|移除/i.test(entry.label) || el.getAttribute('type')==='submit') throw new Error('Use a mapped operation for saving; destructive actions are not supported');
    inspectedControls.clear(); el.click();
    return {status:'control_activated',label:entry.label,verification_scope:'click_only'};
  }
  async function executeBridgeCommand(command) {
    if (command.args?.contractTargets) {
      if (!await loadContractTargets(command.args.contractTargets)) throw new Error('Invalid session contract');
      // A distributable extension deliberately has no resident user's target
      // file. Render the panel as soon as its first agent session arrives.
      render();
    }
    if (!contractReady && !await loadContractTargets()) throw new Error('目前頁面不符合資料契約指定的 LinkedIn 個人檔案；不會執行命令');
    const {action,args={}}=command;
    if (args.locale && args.locale !== localeKey()) {
      if (!contractLocales.includes(args.locale)) throw new Error('資料契約沒有要求的 locale');
      const url=new URL(location.href);
      url.searchParams.set('locale',args.locale.replace('_','-'));
      url.searchParams.delete('language');
      location.href=url.toString(); return {status:'navigating',locale:args.locale};
    }
    if (action==='status') return {status:'ready',url:location.href,locale:localeKey(),version:'4.13.0',targetSource,sharedContentPrimaryLocale,sharedContentOperationIds:[...sharedContentOperationIds],operationIds:OPERATIONS[localeKey()].map(item=>item.id),snapshot:observe()};
    if (action==='inspect_page') return inspectPage();
    if (action==='activate_control') return activateControl(args.controlId);
    if (action==='scan') return {status:'scanned',snapshot:observe(),visible_text:pageText(),links:[...document.querySelectorAll('a[href]')].filter(visible).filter(el=>el.href.startsWith(`https://www.linkedin.com/in/${PROFILE}/`)).map(el=>({text:clean(el.innerText),label:el.getAttribute('aria-label'),url:el.href}))};
    if (action==='inspect_current_form') {
      const fields=formSnapshot(); logFormInspection(fields);
      return {status:'form_inspected',url:location.href,locale:localeKey(),fields};
    }
    if (action==='check_operation_identity') {
      const operation=operationFor(args.operationId);
      if (!operation) throw new Error('資料契約沒有此 operationId');
      return checkOperationIdentity(operation);
    }
    if (action==='navigate') { const destination=new URL(args.url || URLS[args.section] || URLS.overview,location.origin); if(destination.origin!==location.origin || !destination.pathname.startsWith(`/in/${PROFILE}/`)) throw new Error('Navigation must stay in selected profile'); location.href=destination.href; return {status:'navigating'}; }
    if (action==='open_operation') {
      const operation=operationFor(args.operationId);
      if (!operation) throw new Error('資料契約沒有此 operationId');
      const url=new URL(operation.url);
      if (url.origin !== location.origin || !url.pathname.startsWith(`/in/${PROFILE}/`)) throw new Error('operation URL 不屬於資料契約指定個人檔案');
      location.href=operation.url; return {status:'opening_contract_operation',operationId:operation.id};
    }
    if (action==='preview_operation') {
      const operation=operationFor(args.operationId);
      if (!operation) throw new Error('資料契約沒有此 operationId');
      if (new URL(operation.url).pathname.replace(/\/$/,'') !== location.pathname.replace(/\/$/,'')) { location.href=operation.url; return {status:'opening_contract_operation_for_preview',operationId:operation.id,save_requested:false}; }
      return previewOperation(operation);
    }
    if (action==='apply_operation' || action==='apply_and_save_operation') {
      const operation=operationFor(args.operationId);
      if (!operation) throw new Error('資料契約沒有此 operationId');
      requireSelectedForApply(operation.id);
      if (new URL(operation.url).pathname.replace(/\/$/,'') !== location.pathname.replace(/\/$/,'')) throw new Error('目前不是該 operation 的可見表單；先 open_operation');
      return {status:action==='apply_operation'?'filled':'save_clicked',operation:await applyOperation(operation,action==='apply_and_save_operation')};
    }
    if (action==='verify_operation') {
      const operation=operationFor(args.operationId);
      if (!operation) throw new Error('資料契約沒有此 operationId');
      if (new URL(operation.url).pathname.replace(/\/$/,'') !== location.pathname.replace(/\/$/,'')) throw new Error('目前不是該 operation 的可見表單；先 open_operation');
      return verifyOperation(operation);
    }
    if (action==='read_history') { const data=load(); return {status:'ok',profile:`https://www.linkedin.com/in/${PROFILE}/`,change_history:data.change_history||[],form_inspections:data.form_inspections||[],operation_verifications:data.operation_verifications||[],review_selection:data.review_selection||{}}; }
    if (action==='export_logger') { const snapshot=observe(); await download(snapshot); return {status:'download_requested',snapshot}; }
    throw new Error(`未知 MCP 動作：${action}`);
  }
  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
      if (message?.type !== 'bridgeCommand' || !message.command) return false;
      executeBridgeCommand(message.command).then(sendResponse,error=>sendResponse({error:String(error?.message || error)}));
      return true;
    });
  }
  // The background worker owns the MCP queue. This only wakes it periodically;
  // it neither reads nor modifies LinkedIn data.
  if (globalThis.chrome?.runtime?.sendMessage && !globalThis.__linkedinResumeBridgeHeartbeat) {
    globalThis.__linkedinResumeBridgeHeartbeat = true;
    const heartbeat = () => chrome.runtime.sendMessage({type:'bridgeHeartbeat'}).catch(() => {});
    heartbeat();
    setInterval(heartbeat, 20000);
  }
  function observe() {
    const data = load();
    const locale = localeKey();
    // Snapshot only what the visible form exposes.  Interpreting a profile
    // section belongs to an operation's contract mapping, never to a specific
    // person's company, project, or historical LinkedIn form ID.
    const snapshot = {captured_at:new Date().toISOString(), source_url:location.href,
      locale, visible_form:formSnapshot(), verification_scope:'visible_form_only'};
    data.snapshots ||= [];
    data.snapshots.push(snapshot);
    data.snapshots=data.snapshots.slice(-50);
    data.meta = {schema_version:'4.7', artifact_type:'linkedin_profile_audit_logger', profile_url:`https://www.linkedin.com/in/${PROFILE}/`, locales:contractLocales, updater_version:'4.13.0', shared_content_primary_locale:sharedContentPrimaryLocale, shared_content_operation_ids:[...sharedContentOperationIds]};
    save(data); return data;
  }
  async function download(data) {
    if (globalThis.chrome?.runtime?.sendMessage) {
      try {
        const response = await globalThis.chrome.runtime.sendMessage({type:'downloadLogger', data});
        if (response?.ok) return;
      } catch (error) { console.warn('Extension download fallback:', error); }
    }
    const blob = new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=`linkedin-audit-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function render() {
    document.getElementById('li-audit-v2')?.remove();
    const data=observe(), panel=document.createElement('aside'); panel.id='li-audit-v2';
    panel.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483640;width:390px;max-height:80vh;overflow:auto;background:#fff;color:#172b4d;border:1px solid #d8e1ed;border-radius:18px;box-shadow:0 18px 48px #17365a2b;padding:18px;font:13px/1.45 system-ui';
    const locale=localeKey(), operations=OPERATIONS[locale] || [], ledger=load();
    // Approval is opt-in. A new plan starts with no operations selected.
    const selected=new Set(reviewSelection(locale) ?? []);
    const verified=new Set((ledger.operation_verifications || []).filter(item=>item.verified).map(item=>item.operationId));
    const changed=new Set((ledger.change_history || []).map(item=>item.action?.replace('operation:','')).filter(Boolean));
    const sectionNames={intro:'個人檔案',headline:'個人檔案',about:'關於',experience:'工作經歷',project:'專案',projects:'專案',skill:'技能',skills:'技能',certification:'證照',certifications:'證照'};
    const fieldNames={text:'頭銜',title:'職稱',organization:'組織',description:'說明',name:'名稱',start_month:'開始月份',start_year:'開始年份',end_month:'結束月份',end_year:'結束年份',current_position:'目前職務',skill:'技能'};
    const make=(tag,text,style)=>{const el=document.createElement(tag); if(text) el.textContent=text; if(style) el.style.cssText=style; return el;};
    const button=(label,fn,primary=false)=>{const b=make('button',label,`padding:8px 10px;border:1px solid ${primary?'#0a66c2':'#b9c9da'};border-radius:9px;background:${primary?'#0a66c2':'#fff'};color:${primary?'#fff':'#21415f'};cursor:pointer;font:650 12px/1.2 system-ui`); b.onclick=fn; return b;};
    const addBlock=(title,detail)=>{const block=make('section',null,'margin-top:14px;padding-top:13px;border-top:1px solid #e7edf5');block.append(make('div',title,'font-weight:750;color:#17365a')); if(detail) block.append(make('div',detail,'color:#617286;margin-top:3px')); panel.append(block); return block;};
    const header=make('div',null,'display:flex;align-items:flex-start;justify-content:space-between;gap:10px');
    const brand=make('div',null,'display:flex;gap:10px;align-items:center'); brand.append(make('div','RC','display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:#0a66c2;color:#fff;font-weight:800'));
    const title=make('div'); title.append(make('div','履歷同步中心','font-size:16px;font-weight:800;letter-spacing:-.2px')); title.append(make('div','已連線 · 只有明確勾選的項目才允許套用','color:#54708b;font-size:12px;margin-top:1px')); brand.append(title); header.append(brand); header.append(make('div','安全模式','padding:4px 7px;border-radius:999px;background:#e9f7ef;color:#147a46;font-size:11px;font-weight:700')); panel.append(header);
    const language=make('div',null,'display:flex;gap:6px;margin-top:15px');
    const displayLocales=[...contractLocales].sort((a,b)=>(a==='zh_TW'?-1:b==='zh_TW'?1:a.localeCompare(b)));
    for (const contractLocale of displayLocales) { const active=contractLocale===locale; language.append(button(contractLocale==='zh_TW'?'中文':'English',()=>{location.href=`${URLS.overview}?locale=${encodeURIComponent(contractLocale.replace('_','-'))}`;},active)); }
    panel.append(language);
    const status=addBlock('目前進度',`${operations.length} 個待審核操作 · ${verified.size} 個已驗證`);
    const steps=make('div',null,'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:9px');
    [['盤點','完成'],['對應','完成'],['套用',changed.size?'進行中':'待執行'],['驗證',verified.size?'已驗證':'待驗證']].forEach(([label,state],index)=>{const card=make('div',null,`padding:7px;border-radius:9px;background:${index<2?'#edf6ff':'#f6f8fa'};text-align:center`);card.append(make('div',String(index+1),'font-weight:800;color:#0a66c2'));card.append(make('div',label,'font-size:11px;font-weight:700'));card.append(make('div',state,'font-size:10px;color:#617286'));steps.append(card);}); status.append(steps);
    const review=addBlock('逐項審核',`${selected.size}/${operations.length} 個操作已納入本次套用；未選取的操作會被 MCP 阻擋。`);
    review.append(button('全選',()=>{saveReviewSelection(locale,operations.map(operation=>operation.id));render();})); review.append(button('清除選取',()=>{saveReviewSelection(locale,[]);render();}));
    const changes=addBlock('待處理與已驗證的資料',operations.length?'點選項目可開啟相對應的 LinkedIn 表單；儲存一律由 Codex 透過契約執行。':'此語言尚無可執行變更。請先請 Codex 掃描並建立映射。');
    for (const operation of operations) { const card=make('article',null,'margin-top:8px;padding:10px;border:1px solid #dce6f0;border-radius:11px;background:#fbfdff'); const row=make('div',null,'display:flex;align-items:center;justify-content:space-between;gap:8px'); const label=sectionNames[operation.section] || operation.section; row.append(make('div',`${label} · ${operation.operation==='create'?'新增':'更新'}`,'font-weight:750')); const state=verified.has(operation.id)?'已驗證':changed.has(operation.id)?'已套用':'待處理'; row.append(make('div',state,`font-size:11px;font-weight:700;color:${verified.has(operation.id)?'#147a46':changed.has(operation.id)?'#a65d00':'#54708b'}`)); card.append(row); const choice=make('label',null,'display:flex;gap:6px;align-items:center;margin-top:7px;color:#264e77;font-size:12px;cursor:pointer'); const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.checked=selected.has(operation.id); checkbox.onchange=()=>{const next=new Set(reviewSelection(locale) ?? []); checkbox.checked?next.add(operation.id):next.delete(operation.id); saveReviewSelection(locale,[...next]);render();}; choice.append(checkbox,make('span','納入本次套用')); card.append(choice); card.append(make('div',`${Object.keys(operation.fields || {}).length} 個欄位已映射`,'color:#617286;font-size:12px;margin-top:2px')); const preview=make('details',null,'margin-top:7px'); preview.append(make('summary','預覽預計寫入的內容','cursor:pointer;color:#264e77;font-size:12px;font-weight:650')); for (const [field,value] of Object.entries(operation.fields || {})) { const valueText=String(Array.isArray(value)?value.join('、'):value); const clipped=valueText.length>180?`${valueText.slice(0,180)}…`:valueText; preview.append(make('div',`${fieldNames[field] || field}：${clipped}`,'margin-top:5px;color:#40566d;font-size:12px;white-space:pre-wrap')); } preview.append(make('div','實際變更前內容由 Codex 的唯讀預覽命令在開啟表單後比對。','margin-top:7px;color:#617286;font-size:11px')); card.append(preview); const actions=make('div',null,'margin-top:8px'); actions.append(button('查看表單',()=>{location.href=operation.url;})); card.append(actions); changes.append(card); }
    const quick=addBlock('快速導覽','檢視目前履歷資料；不會直接寫入 LinkedIn。'); [['個人檔案',URLS.overview],['工作經歷',URLS.experience],['專案',URLS.projects],['技能',URLS.skills]].forEach(([label,url])=>quick.append(button(label,()=>{location.href=localized(url);}))); quick.append(button('重新掃描',render,true));
    const handoff=addBlock('下一步',selected.size?`已選取 ${selected.size} 項。交給 Codex 預覽差異後，只需再確認一次才會儲存。`:'請至少選取一項後再交給 Codex。');
    const handoffStatus=make('div','', 'margin-top:7px;color:#147a46;font-size:12px;font-weight:650');
    const handoffButton=button(selected.size?`複製給 Codex：預覽 ${selected.size} 項`:'請先選取項目',async()=>{
      if (!selected.size) return;
      const message=`請用 Resume Contract Studio 預覽我在插件中已選取的 ${locale} ${selected.size} 項操作，逐項顯示目前值與目標值；先不要儲存，等待我確認後再套用。`;
      try { await navigator.clipboard.writeText(message); handoffStatus.textContent='已複製。貼到 Codex 即可開始預覽。'; }
      catch (_) { handoffStatus.textContent='無法存取剪貼簿；請在 Codex 輸入「預覽已選取項目」。'; }
    },true); handoffButton.disabled=!selected.size; if (!selected.size) handoffButton.style.cssText+=';opacity:.55;cursor:not-allowed'; handoff.append(handoffButton,handoffStatus);
    const diagnostics=make('details',null,'margin-top:14px;padding-top:12px;border-top:1px solid #e7edf5;color:#617286'); diagnostics.append(make('summary','進階診斷與紀錄','cursor:pointer;font-weight:700;color:#264e77')); diagnostics.append(make('div',`語言：${locale} · 已記錄 ${changed.size} 筆變更、${verified.size} 筆驗證`,'margin-top:7px')); diagnostics.append(button('匯出 Logger',()=>void download(observe()))); panel.append(diagnostics);
    document.body.append(panel);
  }
  async function start() {
    if (!await loadContractTargets()) return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',render,{once:true}); else render();
    let last=location.href; setInterval(()=>{if(location.href!==last){last=location.href;setTimeout(render,1200)}},1000);
    // The MV3 background worker owns the bridge queue, preventing duplicate
    // consumers from racing to take the same command.
  }
  void start();
})();
