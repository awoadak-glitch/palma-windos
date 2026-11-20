// Runs inside the real Electron process; exercises the renderer-to-updater bridge.
import {app,BrowserWindow,protocol} from 'electron';
import fs from 'node:fs';
import originalFS from 'original-fs';
import assert from 'node:assert/strict';
import {createUpdateManager} from './update-manager.mjs';

app.whenReady().then(async()=>{
  const runtime=globalThis[Symbol.for('palma.updateRuntime')];
  const manager=createUpdateManager({fs:originalFS,store:runtime.store,version:runtime.version,onReady:()=>runtime.healthy(),fetchImpl:()=>{throw Error('Unexpected network request in smoke test');}});
  protocol.handle('palma',request=>{
    const pathname=new URL(request.url).pathname;
    if(pathname==='/api/desktop/updates')return manager.handle(request);
    if(pathname==='/desktop-updates.js')return new Response(fs.readFileSync(new URL('./desktop-updates.js',import.meta.url)),{headers:{'Content-Type':'text/javascript'}});
    return new Response('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><body><div id="host"></div></body></html>',{headers:{'Content-Type':'text/html; charset=utf-8'}});
  });
  const window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setBackgroundThrottling(false);
  await window.loadURL('palma://app/');
  const result=await window.webContents.executeJavaScript(`(async()=>{
    const {renderDesktopUpdates}=await import('/desktop-updates.js');
    renderDesktopUpdates(document.getElementById('host'));
    const ready=await fetch('/api/desktop/updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ready'})});
    if(!ready.ok)throw Error('Renderer health request rejected: '+ready.status);
    const status=await fetch('/api/desktop/updates');
    if(!status.ok)throw Error('Renderer status request rejected: '+status.status);
    const data=await status.json();
    const deadline=Date.now()+5000;
    while((!document.getElementById('update-version').textContent.includes(data.version)||document.getElementById('update-check').disabled)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    return {version:data.version,hasUpdateButton:Boolean(document.getElementById('update-check')),
      readyWithoutSetup:data.configured&&!document.getElementById('update-check').disabled&&document.getElementById('update-version').textContent.includes(data.version),
      hasRepositoryControls:Boolean(document.querySelector('#update-repository,#update-config'))};
  })()`);
  assert.deepEqual(result,{version:runtime.version,hasUpdateButton:true,readyWithoutSetup:true,hasRepositoryControls:false});
  fs.writeFileSync(process.env.PALMA_TEST_RESULT,JSON.stringify({version:runtime.version,asar:import.meta.url.includes('.asar/')}));
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
