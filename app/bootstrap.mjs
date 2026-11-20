import {app,protocol,dialog} from 'electron';
import originalFS from 'original-fs';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {createUpdateStore} from './update-store.mjs';

// This stable entry point stays in the installed app. New code is staged beside
// user settings, never written over a running archive or the user's library.
protocol.registerSchemesAsPrivileged([{scheme:'palma',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.setAppUserModelId('com.palma.vision.desktop');
const selfTest=process.argv.includes('--self-test');
if(!selfTest&&!app.requestSingleInstanceLock()){
  app.quit();
}else{
  const bundledVersion=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
  const store=createUpdateStore({fs:originalFS,root:path.join(app.getPath('userData'),'palma-updates'),bundledVersion});
  let selection;
  try{selection=selfTest?{version:bundledVersion,trial:false}:store.select();}
  catch{selection={version:bundledVersion,trial:false,lastError:'تعذر فتح سجل التحديث؛ استُخدمت النسخة المثبتة.'};}
  let healthy=!selection.trial,rollingBack=false,watchdog;
  function failed(){
    if(healthy||rollingBack)return false;
    rollingBack=true;clearTimeout(watchdog);try{store.reject(selection.record);}catch{}app.relaunch();app.exit(1);return true;
  }
  globalThis[Symbol.for('palma.updateRuntime')]=Object.freeze({
    store,version:selection.version,bundledVersion,lastError:selection.lastError||'',
    healthy(){if(!healthy){store.confirm(selection.record);healthy=true;clearTimeout(watchdog);}},
    failed,
  });
  if(selection.trial){watchdog=setTimeout(failed,45000);watchdog.unref();}
  try{
    const entry=selection.record?path.join(selection.record.file,'main.mjs'):fileURLToPath(new URL('./main.mjs',import.meta.url));
    await import(pathToFileURL(entry).href);
  }catch(error){
    if(!failed()){await app.whenReady();dialog.showErrorBox('تعذر فتح بالما','تعذر بدء التطبيق. أعد تثبيت حزمة بالما مع الاحتفاظ ببياناتك.');app.exit(1);}
  }
}
