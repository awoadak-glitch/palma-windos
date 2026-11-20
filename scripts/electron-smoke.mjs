// Real Electron integration check: bundled startup, ASAR activation, then rollback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createUpdateStore} from '../app/update-store.mjs';
import {sha256} from '../app/update-contract.mjs';

if(!process.argv[2])throw Error('Pass the Electron executable path.');
const electron=path.resolve(process.argv[2]);
if(!fs.existsSync(electron))throw Error('Electron executable is missing. Run node node_modules/electron/install.js first.');
const project=fileURLToPath(new URL('../',import.meta.url));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'palma-electron-smoke-'));
const appRoot=path.join(temporary,'fixture'),userData=path.join(temporary,'userdata'),output=path.join(temporary,'result.json');
fs.mkdirSync(appRoot);fs.mkdirSync(userData);
const resultMain=fs.readFileSync(path.join(project,'scripts/electron-fixture-main.mjs'),'utf8');
const baseFiles=Object.fromEntries(['bootstrap.mjs','update-contract.mjs','update-store.mjs','update-manager.mjs','bridge.mjs'].map(n=>[n,fs.readFileSync(path.join(project,'app',n))]));
baseFiles['desktop-updates.js']=fs.readFileSync(path.join(project,'app/web/public/desktop-updates.js'));
for(const [name,bytes]of Object.entries(baseFiles))fs.writeFileSync(path.join(appRoot,name),bytes);
fs.writeFileSync(path.join(appRoot,'package.json'),JSON.stringify({name:'palma-vision',version:'2.4.0',type:'module',main:'entry.mjs'}));
fs.writeFileSync(path.join(appRoot,'entry.mjs'),`import {app} from 'electron';app.setPath('userData',process.env.PALMA_TEST_USERDATA);await import('./bootstrap.mjs');`);
fs.writeFileSync(path.join(appRoot,'main.mjs'),resultMain);
const store=createUpdateStore({fs,root:path.join(userData,'palma-updates'),bundledVersion:'2.4.0'});
function stage(version,main=resultMain){
  const values={...baseFiles,'main.mjs':Buffer.from(main),'package.json':Buffer.from(JSON.stringify({name:'palma-vision',version,type:'module',main:'bootstrap.mjs'}))};
  const files={},chunks=[];let offset=0;
  for(const [name,bytes]of Object.entries(values)){files[name]={offset:String(offset),size:bytes.length};offset+=bytes.length;chunks.push(bytes);}
  const json=Buffer.from(JSON.stringify({files})),padding=(4-json.length%4)%4,head=Buffer.alloc(16);head.writeUInt32LE(4);head.writeUInt32LE(8+json.length+padding,4);head.writeUInt32LE(4+json.length+padding,8);head.writeUInt32LE(json.length,12);
  const archive=Buffer.concat([head,json,Buffer.alloc(padding),...chunks]),record={version,size:archive.length,sha256:sha256(archive)};fs.writeFileSync(store.fileFor(record),archive);store.stage(record);
}
async function launch(expected,asar){
  fs.rmSync(output,{force:true});
  const args=[appRoot,...(process.platform==='linux'?['--no-sandbox','--disable-gpu','--ozone-platform=headless']:[])];
  const child=spawn(electron,args,{env:{...process.env,PALMA_TEST_USERDATA:userData,PALMA_TEST_RESULT:output},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
  let launchError;child.on('error',e=>{launchError=e;});
  for(let i=0;i<120&&!fs.existsSync(output)&&!launchError;i++)await new Promise(r=>setTimeout(r,250));
  if(launchError||!fs.existsSync(output)){child.kill();throw Error('Electron smoke failed: '+(launchError?.message||logs.slice(-2500)));}
  const result=JSON.parse(fs.readFileSync(output,'utf8'));assert.deepEqual(result,{version:expected,asar});
  await new Promise(r=>setTimeout(r,300));console.log('Electron smoke passed:',expected,asar?'ASAR':'bundled');
}
try{
  await launch('2.4.0',false);
  stage('2.4.1');await launch('2.4.1',true);assert.equal(store.read().current.version,'2.4.1');
  stage('2.4.2',`throw Error('Simulated faulty update');`);await launch('2.4.1',true);assert.equal(store.read().pending,null);
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
