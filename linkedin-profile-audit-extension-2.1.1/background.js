'use strict';

const BRIDGE='http://127.0.0.1:37841';
let polling=false;
let targetProfilePromise;

async function targetProfile(targets) {
  if (targets) {
    const url=new URL(targets.profile_url);
    if(url.origin!=="https://www.linkedin.com" || !/^\/in\/[^/]+\/$/.test(url.pathname)) throw new Error("Invalid session profile");
    return {url:url.href,pattern:`${url.origin}${url.pathname}*`};
  }
  targetProfilePromise ||= fetch(chrome.runtime.getURL('profile-targets.json'), {cache:'no-store'})
    .then(response => response.ok ? response.json() : Promise.reject(new Error(`target contract HTTP ${response.status}`)))
    .then(data => {
      const url = new URL(data?.profile_url || '');
      if (url.origin !== 'https://www.linkedin.com' || !/^\/in\/[^/]+\/$/.test(url.pathname)) {
        throw new Error('資料契約沒有有效的公開 LinkedIn 個人檔案網址');
      }
      return {url: url.toString(), pattern: `${url.origin}${url.pathname}*`};
    });
  return targetProfilePromise;
}

async function postResult(result) {
  await fetch(`${BRIDGE}/result`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(result)
  });
}

async function deliverToProfileTab(tabId, command) {
  try {
    return await chrome.tabs.sendMessage(tabId,{type:'bridgeCommand',command});
  } catch (error) {
    // A page that was already open when the extension reloaded has no content
    // script. Inject the same reviewed script once, then retry the command.
    if (!String(error).includes('Receiving end does not exist')) throw error;
    await chrome.scripting.executeScript({target:{tabId},files:['linkedin_profile_audit_v2.user.js']});
    // Allow the injected document script to register its message listener before
    // retrying the command. This avoids losing the first command after reload.
    await new Promise(resolve => setTimeout(resolve, 75));
    return chrome.tabs.sendMessage(tabId,{type:'bridgeCommand',command});
  }
}

async function waitForPageLoad(tabId, timeoutMs=15000) {
  const current=await chrome.tabs.get(tabId);
  if (current.status==='complete') return;
  return new Promise((resolve,reject) => {
    const timer=setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('LinkedIn 個人檔案頁載入逾時')); },timeoutMs);
    const listener=(updatedId,info) => {
      if (updatedId===tabId && info.status==='complete') {
        clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function findOrOpenProfileTab(targets) {
  const profile=await targetProfile(targets);
  const tabs=await chrome.tabs.query({url:profile.pattern});
  const existing=tabs.find(item=>item.active) || tabs[0];
  if (existing?.id) return existing;
  const created=await chrome.tabs.create({url:profile.url,active:true});
  await waitForPageLoad(created.id);
  return created;
}

async function pollBridge() {
  if (polling) return;
  polling=true;
  let command=null;
  try {
    const response=await fetch(`${BRIDGE}/next`, {cache:'no-store'});
    if (response.status === 204) return;
    command=await response.json();
    const tab=await findOrOpenProfileTab(command.args?.contractTargets);
    if (!tab?.id) {
      await postResult({id:command.id,ok:false,error:'找不到已開啟的目標 LinkedIn 個人檔案分頁'});
      return;
    }
    try {
      const result=await deliverToProfileTab(tab.id,command);
      await postResult({id:command.id,ok:!result?.error,result});
    } catch (error) {
      await postResult({id:command.id,ok:false,error:String(error)});
    }
  } catch (error) {
    // MCP bridge may be offline; retry quietly. If it did supply a command,
    // return a diagnostic instead of silently letting the caller time out.
    if (command?.id) {
      try { await postResult({id:command.id,ok:false,error:String(error?.message || error)}); } catch (_) {}
    }
  } finally { polling=false; }
}

setInterval(pollBridge,1200);
void pollBridge();

// MV3 workers are suspended when idle, so do not rely on their interval alone.
// A completed LinkedIn profile navigation is a durable extension event and
// wakes the bridge even when the content script has not yet sent its heartbeat.
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && /^https:\/\/www\.linkedin\.com\/in\/[^/]+(?:\/|$)/.test(tab.url || '')) {
    void pollBridge();
  }
});
chrome.runtime.onStartup.addListener(() => void pollBridge());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // MV3 workers can sleep between timers. The page sends a harmless heartbeat
  // while this approved profile is open so queued MCP commands wake the worker.
  if (message?.type === 'bridgeHeartbeat') {
    void pollBridge();
    sendResponse({ok:true});
    return false;
  }
  if (message?.type === 'readContractTargets') {
    fetch(chrome.runtime.getURL('profile-targets.json'), {cache:'no-store'})
      .then(async response => response.ok ? response.json() : Promise.reject(new Error(`target contract HTTP ${response.status}`)))
      .then(data => sendResponse({ok:true,data}))
      .catch(error => sendResponse({ok:false,error:String(error)}));
    return true;
  }
  if (message?.type === 'bridgeResult') {
    fetch(`${BRIDGE}/result`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(message.result)
    }).then(() => sendResponse({ok:true}))
      .catch(error => sendResponse({ok:false, error:String(error)}));
    return true;
  }
  if (message?.type !== 'downloadLogger' || !message.data) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const json = JSON.stringify(message.data, null, 2) + '\n';
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  chrome.downloads.download({
    url,
    filename: `linkedin-audit-${stamp}.json`,
    saveAs: false,
    conflictAction: 'uniquify'
  }).then(
    id => sendResponse({ok:true, downloadId:id}),
    error => sendResponse({ok:false, error:String(error)})
  );
  return true;
});
