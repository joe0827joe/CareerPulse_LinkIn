'use strict';
const BRIDGE='http://127.0.0.1:37841';
const status=document.getElementById('status');
const code=document.getElementById('pairingCode');
const button=document.getElementById('pairButton');
async function checkStatus(){
  const {bridgeToken}=await chrome.storage.session.get('bridgeToken');
  if(!bridgeToken){status.textContent='尚未配對。';return;}
  try{
    const response=await fetch(`${BRIDGE}/health`,{headers:{'X-Bridge-Token':bridgeToken},cache:'no-store'});
    if(response.status===401){await chrome.storage.session.remove('bridgeToken');status.textContent='配對已失效，請重新配對。';return;}
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    status.textContent='Bridge 已配對並連線。';
  }catch(error){status.textContent=`目前無法連線 Bridge：${error.message}`;}
}
document.getElementById('pairForm').addEventListener('submit',async event=>{
  event.preventDefault();
  const pairingCode=code.value.trim();
  if(!/^[A-Za-z0-9_-]{24}$/.test(pairingCode)){status.textContent='配對代碼格式錯誤。';return;}
  button.disabled=true;
  try{
    const response=await fetch(`${BRIDGE}/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode})});
    if(!response.ok)throw new Error(`配對失敗 (HTTP ${response.status})，請確認代碼及效期`);
    const data=await response.json();
    if(!data.ok||!data.token)throw new Error('配對回應無效');
    await chrome.storage.session.set({bridgeToken:data.token});
    code.value='';
    status.textContent='配對成功。';
    chrome.runtime.sendMessage({type:'bridgePaired'}).catch(()=>{});
  }catch(error){status.textContent=error.message;}
  finally{button.disabled=false;}
});
void checkStatus();
