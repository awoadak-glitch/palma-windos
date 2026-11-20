import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {createUpdateStore} from '../app/update-store.mjs';
import {createUpdateManager,fetchUpdate,allowedUpdateURL} from '../app/update-manager.mjs';
import {sha256,inspectArchive,validateManifest,repositoryName,compareVersions,UPDATE_RUNTIME} from '../app/update-contract.mjs';

const repo='awoadak-glitch/PALMA';
function archive(version='2.4.1',overrides={}){
  const values={'package.json':JSON.stringify({name:'palma-vision',version,type:'module',main:'bootstrap.mjs'}),'main.mjs':'export const ready=true;','bootstrap.mjs':'export const bootstrap=true;',...overrides};
  const files={},chunks=[];let offset=0;
  for(const [name,value] of Object.entries(values)){const bytes=Buffer.from(value);files[name]={size:bytes.length,offset:String(offset)};offset+=bytes.length;chunks.push(bytes);}
  const json=Buffer.from(JSON.stringify({files})),padding=(4-json.length%4)%4,head=Buffer.alloc(16);head.writeUInt32LE(4);head.writeUInt32LE(8+json.length+padding,4);head.writeUInt32LE(4+json.length+padding,8);head.writeUInt32LE(json.length,12);
  return Buffer.concat([head,json,Buffer.alloc(padding),...chunks]);
}
function fixture(version='2.4.1'){
  const raw=archive(version),compressed=gzipSync(raw);
  const manifest={schema:1,app:'com.palma.vision.desktop',version,runtime:UPDATE_RUNTIME,minBootstrap:1,url:`https://github.com/${repo}/releases/download/v${version}/PALMA-VISION-${version}.asar.gz`,size:compressed.length,sha256:sha256(compressed),unpackedSize:raw.length,unpackedSha256:sha256(raw),notes:'إصلاحات التشغيل'};
  return {raw,compressed,manifest,record:{version,sha256:manifest.unpackedSha256,size:raw.length}};
}
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'palma-updates-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const store=createUpdateStore({fs,root,bundledVersion:'2.4.0'});return {root,store};}
function installFile(store,f){fs.writeFileSync(store.fileFor(f.record),f.raw);store.stage(f.record);}
function request(body,origin='palma://app',method='POST'){
  const r=new Request('palma://app/api/desktop/updates',{method,...(method==='POST'?{body:JSON.stringify(body)}:{})});Object.defineProperty(r,'initiatorOrigin',{value:origin});return r;
}

test('Repository binding rejects arbitrary hosts, alternate owners and credentials',()=>{
  assert.equal(repositoryName('https://github.com/awoadak-glitch/PALMA/'),repo);
  for(const name of ['https://github.com.evil.test/awoadak-glitch/PALMA','other/PALMA','https://a:b@github.com/awoadak-glitch/PALMA',repo+'/extra'])assert.throws(()=>repositoryName(name));
});
test('Version checks are numeric and disallow rollback labels',()=>{assert.equal(compareVersions('2.4.10','2.4.9'),1);assert.equal(compareVersions('2.4.0','2.4.0'),0);assert.throws(()=>compareVersions('2.4.1-beta','2.4.0'));});
test('Manifest binds app, repository, runtime, asset version and bounded sizes',()=>{
  const {manifest}=fixture();assert.equal(validateManifest(manifest,repo).version,'2.4.1');
  for(const change of [{app:'other'},{runtime:'other'},{minBootstrap:2},{url:manifest.url.replace('PALMA/','other/')},{size:999999999},{sha256:'bad'},{version:'2.4.2'}])assert.throws(()=>validateManifest({...manifest,...change},repo));
});
test('Archive identity and actual packaged version must agree',()=>{
  assert.equal(inspectArchive(archive(),'2.4.1').name,'palma-vision');
  assert.throws(()=>inspectArchive(archive(),'2.4.2'));assert.throws(()=>inspectArchive(Buffer.from('not an archive'),'2.4.1'));
  assert.throws(()=>inspectArchive(archive('2.4.1',{'package.json':JSON.stringify({name:'other',version:'2.4.1'})}),'2.4.1'));
});
test('GitHub redirects never send requests to unrelated sites or HTTP',async()=>{
  let count=0;await assert.rejects(fetchUpdate(`https://github.com/${repo}/releases/latest/download/palma-update.json`,repo,{fetchImpl:async()=>{count++;return new Response(null,{status:302,headers:{location:'https://unrelated.example/file'}});}}));assert.equal(count,1);
  assert.throws(()=>allowedUpdateURL('http://release-assets.githubusercontent.com/file',repo));
  assert.throws(()=>allowedUpdateURL('https://github.com/another/repo/releases/download/v1/a',repo));
});
test('Approved GitHub asset redirect succeeds without credentials',async()=>{
  const seen=[];const r=await fetchUpdate(`https://github.com/${repo}/releases/latest/download/palma-update.json`,repo,{fetchImpl:async(u,o)=>{seen.push([u,o]);return seen.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file?signature=public-download'}}):new Response('ok');}});
  assert.equal(await r.text(),'ok');assert.equal(seen[1][1].headers.Authorization,undefined);assert.equal(seen[1][1].headers.Cookie,undefined);
});
test('Successful update downloads, stages, boots once, then commits after health signal',async t=>{
  const {store,root}=setup(t),f=fixture();fs.writeFileSync(path.join(root,'user-watch-history.json'),'keep me');
  const m=createUpdateManager({fs,store,version:'2.4.0',defaultRepository:repo,fetchImpl:async u=>u.endsWith('.json')?Response.json(f.manifest):new Response(f.compressed)});
  assert.equal((await m.check()).phase,'available');m.download();await m.settled();assert.equal(m.status().phase,'ready');
  const trial=store.select();assert.equal(trial.trial,true);assert.equal(trial.version,'2.4.1');assert.equal(store.read().current,null);
  store.confirm(trial.record);assert.equal(store.select().trial,false);assert.equal(store.select().version,'2.4.1');
  assert.equal(fs.readFileSync(path.join(root,'user-watch-history.json'),'utf8'),'keep me');
});
test('Crash before health confirmation restores last working release',t=>{
  const {store}=setup(t),first=fixture('2.4.1'),second=fixture('2.4.2');installFile(store,first);store.confirm(store.select().record);installFile(store,second);assert.equal(store.select().version,'2.4.2');
  const restarted=store.select();assert.equal(restarted.version,'2.4.1');assert.equal(restarted.trial,false);assert.match(restarted.lastError,/النسخة السابقة/);
});
test('First update crash falls back to bundled version',t=>{const {store}=setup(t);installFile(store,fixture());store.select();assert.equal(store.select().version,'2.4.0');});
test('A corrupted active archive restores the preceding confirmed version',t=>{
  const {store}=setup(t);for(const version of ['2.4.1','2.4.2']){installFile(store,fixture(version));store.confirm(store.select().record);}
  fs.writeFileSync(store.fileFor(store.read().current),'tampered');assert.equal(store.select().version,'2.4.1');
});
test('State file cannot redirect startup outside updater directory',t=>{const {store}=setup(t);store.write({schema:1,current:{version:'2.4.1',sha256:'../../other',size:22}});assert.equal(store.select().version,'2.4.0');});
test('Truncated persistent state falls back without touching user data',t=>{const {store,root}=setup(t);fs.writeFileSync(path.join(root,'state.json'),'{');assert.equal(store.select().version,'2.4.0');});
for(const mode of ['hash','truncated','wrong-version','oversized'])test('Failed package leaves current version intact: '+mode,async t=>{
  const {store}=setup(t),f=fixture();let bytes=f.compressed;
  if(mode==='hash')bytes=Buffer.from(bytes).fill(1,10,12);
  if(mode==='truncated')bytes=bytes.subarray(0,bytes.length-2);
  if(mode==='wrong-version'){const raw=archive('2.4.9');bytes=gzipSync(raw);Object.assign(f.manifest,{size:bytes.length,sha256:sha256(bytes),unpackedSize:raw.length,unpackedSha256:sha256(raw)});}
  if(mode==='oversized')bytes=Buffer.concat([bytes,Buffer.alloc(1)]);
  const m=createUpdateManager({fs,store,version:'2.4.0',defaultRepository:repo,fetchImpl:async u=>u.endsWith('.json')?Response.json(f.manifest):new Response(bytes)});
  await m.check();m.download();await m.settled();assert.equal(m.status().phase,'error');assert.equal(store.read().pending,null);assert.equal(store.select().version,'2.4.0');
});
test('Older release is never offered as an update',async t=>{const {store}=setup(t);const m=createUpdateManager({fs,store,version:'2.5.0',defaultRepository:repo,fetchImpl:async()=>Response.json(fixture().manifest)});assert.equal((await m.check()).phase,'current');assert.throws(()=>m.download());});
test('Concurrent download actions create one request and one staged package',async t=>{
  const {store}=setup(t),f=fixture();let downloads=0;
  const m=createUpdateManager({fs,store,version:'2.4.0',defaultRepository:repo,fetchImpl:async u=>{if(u.endsWith('.json'))return Response.json(f.manifest);downloads++;await new Promise(r=>setTimeout(r,20));return new Response(f.compressed);}});
  await m.check();m.download();m.download();await m.settled();assert.equal(downloads,1);assert.equal(store.read().pending.version,'2.4.1');
});
test('Update endpoint refuses other origins and unsupported methods',async t=>{
  const {store}=setup(t),m=createUpdateManager({fs,store,version:'2.4.0'});
  assert.equal((await m.handle(request({action:'ready'},'https://outside.example'))).status,403);
  assert.equal((await m.handle(request({},'palma://app','DELETE'))).status,405);
});
test('Restart is blocked while video downloads are active',async t=>{
  const {store}=setup(t);installFile(store,fixture());let calls=0;
  const m=createUpdateManager({fs,store,version:'2.4.0',canRestart:()=>false,restart:()=>calls++});
  assert.equal((await m.handle(request({action:'restart'}))).status,400);assert.equal(calls,0);
});
test('Configuration persists and never requires a GitHub token',t=>{
  const {store}=setup(t),m=createUpdateManager({fs,store,version:'2.4.0'});m.configure(repo);
  const reopened=createUpdateManager({fs,store,version:'2.4.0'});assert.equal(reopened.status().repository,repo);
});
test('Cancelling an interrupted download never stages or activates partial bytes',async t=>{
  const {store}=setup(t),f=fixture();
  const m=createUpdateManager({fs,store,version:'2.4.0',defaultRepository:repo,fetchImpl:async(u,o)=>{
    if(u.endsWith('.json'))return Response.json(f.manifest);
    return new Response(new ReadableStream({start(c){c.enqueue(f.compressed.subarray(0,10));o.signal.addEventListener('abort',()=>c.error(o.signal.reason),{once:true});}}));
  }});
  await m.check();m.download();await new Promise(r=>setTimeout(r,10));await m.handle(request({action:'cancel'}));await m.settled();
  assert.equal(store.read().pending,null);assert.equal(store.select().version,'2.4.0');assert.equal(m.status().phase,'error');
});
test('Completed updates retain only current and previous archives',t=>{
  const {store,root}=setup(t);for(const version of ['2.4.1','2.4.2','2.4.3']){installFile(store,fixture(version));store.confirm(store.select().record);}
  assert.equal(fs.readdirSync(root).filter(n=>n.endsWith('.asar')).length,2);
  assert.equal(store.read().previous.version,'2.4.2');
});
