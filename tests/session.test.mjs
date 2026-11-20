import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,createPublicKey,verify} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PalmaClient,APP_PROFILE,canonicalRequest} from '../app/web/server/palma/client.mjs';
import {createIdentityStore} from '../app/identity-store.mjs';

function fixture(){
  const f={time:Date.now(),state:null,registrations:0,refreshes:0,catalogues:0,playbacks:0,keys:[],tokens:[],rejectCatalog:0,refreshStatus:0,unknownRefresh:false,unknownPlayback:0};
  const now=()=>Math.floor(f.time/1000);
  const respond=(body,status=200,headers={})=>Response.json(body,{status,headers:{'X-Server-Time':String(now()),...headers}});
  const token=()=>{f.hot=createHash('sha256').update('test-session-'+f.tokens.length).digest('hex');f.tokens.push(f.hot);f.exp=now()+3600;return {hot_token:f.hot,hot_exp:f.exp,ttl:3600};};
  const signature=(url,opts)=>{const h=opts.headers;assert.equal(h['X-Key-Id'],f.keyId);assert.ok(verify('sha256',Buffer.from(canonicalRequest(opts.method,url,opts.body||'',h['X-V3-Ts'],h['X-V3-Nonce'])),f.publicKey,Buffer.from(h['X-Sig-V3'].slice(6),'base64')));};
  f.fetch=async(url,opts)=>{
    const u=new URL(url),h=opts.headers;
    if(u.pathname.endsWith('/ping.php'))return respond({});
    if(u.pathname.endsWith('/challenge.php'))return respond({status:'success'});
    if(u.pathname.endsWith('/register.php')){
      f.registrations++;const b=JSON.parse(opts.body);assert.equal(b.app_version,'1.1.7');
      f.publicKey=createPublicKey(b.public_key);f.keys.push(b.public_key);f.keyId=createHash('sha256').update(f.publicKey.export({format:'der',type:'spki'})).digest('hex');
      return respond({status:'success',key_id:f.keyId,device_secret:'ab'.repeat(32),...token()});
    }
    if(u.pathname.endsWith('/token.php')){
      f.refreshes++;signature(u,opts);assert.equal(opts.method,'POST');assert.equal(opts.body,'');
      if(f.unknownRefresh){f.unknownRefresh=false;return respond({status:'error'},403,{'X-V3-Reason':'unknown_key'});}
      if(f.refreshStatus)return respond({status:'error'},f.refreshStatus,{'Retry-After':'60'});
      return respond({status:'success',...token()});
    }
    if(u.pathname.startsWith('/api/v3/')){
      f.playbacks++;signature(u,opts);
      if(f.unknownPlayback-->0)return respond({status:'error'},403,{'X-V3-Reason':'unknown_key'});
      return respond({status:'success',data:{id:1,watch_links:[{id:2}]}});
    }
    f.catalogues++;
    assert.equal(h['X-App-Ver'],'19');assert.equal(h['X-Key-Id'],f.keyId);assert.ok(Number(h['X-HT-Exp'])>now()+120,'never request catalogue without a usable session');
    assert.equal(h['X-D-Sig'],createHmac('sha256',Buffer.from(f.hot,'hex')).update(canonicalRequest(opts.method,u,opts.body||'',h['X-D-Ts'],h['X-D-Nonce'])).digest('hex'));
    if(f.rejectCatalog-->0)return respond({status:'error'},403,{'X-Hot-Reason':f.rejectReason||'token_expired'});
    if(['/api/v2/home.php','/api/series/','/api/movies/','/api/episodes/','/api/content-categories.php','/api/series/filters.php','/api/search/all.php'].includes(u.pathname))assert.equal(u.searchParams.get('app_version'),'19');
    return respond({status:'success',data:[{id:1,title:'sample'}]});
  };
  f.open=()=>new PalmaClient({base:'https://source.example/',fetchImpl:f.fetch,now:()=>f.time,stateStore:{load:async()=>structuredClone(f.state),save:async state=>{f.state=structuredClone(state);}}});
  f.client=f.open();return f;
}
test('Oscar profile and all versioned catalogue routes use 1.1.7 / 19',async()=>{
  assert.equal(APP_PROFILE.version_name,'1.1.7');const f=fixture();
  for(const route of ['api/v2/home.php','api/series/','api/movies/','api/episodes/','api/content-categories.php','api/series/filters.php','api/search/all.php'])await f.client.get(route);
  assert.equal(f.registrations,1);assert.equal(f.refreshes,0);assert.equal(f.catalogues,7);
});
test('Watching then returning after expiry renews once for simultaneous catalogue loads',async()=>{
  const f=fixture();await f.client.get('api/v2/home.php');await f.client.get('api/episodes/show.php',{id:1});
  const device=f.state.identity.device_id;f.time+=61*60*1000;
  const results=await Promise.all(Array.from({length:8},()=>f.client.get('api/v2/home.php')));
  assert.ok(results.every(x=>x.body.data.length));assert.equal(f.refreshes,1);assert.equal(f.registrations,1);assert.equal(f.state.identity.device_id,device);
  const reopened=f.open();await reopened.get('api/series/');assert.equal(f.refreshes,1);
  f.time+=4*3600*1000;await reopened.get('api/series/');assert.equal(f.refreshes,2);assert.equal(f.registrations,1);
});
test('Pre-expiry renewal occurs before catalogue request',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.time+=41*60*1000;await f.client.get('api/movies/');assert.equal(f.refreshes,1);
});
test('Explicit expired-token rejection refreshes and retries the request once',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.rejectCatalog=1;await f.client.get('api/movies/');assert.equal(f.refreshes,1);assert.equal(f.catalogues,3);
});
test('Concurrent rejected-token responses share one renewal',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.rejectCatalog=6;
  await Promise.all(Array.from({length:6},()=>f.client.get('api/movies/')));assert.equal(f.refreshes,1);assert.equal(f.registrations,1);
});
test('A policy rejection does not trigger token or device churn',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.rejectCatalog=1;f.rejectReason='policy_denied';
  await assert.rejects(f.client.get('api/movies/'),{code:'UPSTREAM_REJECTED'});assert.equal(f.refreshes,0);assert.equal(f.registrations,1);
});
test('Saved device without a hot token obtains a token without registering again',async()=>{
  const f=fixture();await f.client.get('api/movies/');delete f.state.identity.hot_token;delete f.state.identity.hot_exp;
  await f.open().get('api/movies/');assert.equal(f.refreshes,1);assert.equal(f.registrations,1);
});
test('Server-lost registration during renewal recovers the same device and public key',async()=>{
  const f=fixture();await f.client.get('api/movies/');const device=f.state.identity.device_id;f.time+=3600*1000;f.unknownRefresh=true;
  await f.client.get('api/movies/');assert.equal(f.registrations,2);assert.equal(f.refreshes,1);assert.equal(f.state.identity.device_id,device);assert.equal(f.keys[0],f.keys[1]);
});
test('Concurrent V3 unknown-key failures share device recovery',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.unknownPlayback=2;
  await Promise.all([f.client.get('api/movies/show.php',{id:1}),f.client.get('api/episodes/show.php',{id:1})]);assert.equal(f.registrations,2);
});
test('Temporary renewal outage retains a still-usable session but never sends an expired one',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.time+=41*60*1000;f.refreshStatus=503;
  await f.client.get('api/movies/');assert.equal(f.refreshes,1);assert.equal(f.catalogues,2);
  f.time+=20*60*1000;await assert.rejects(f.client.get('api/movies/'),{code:'UPSTREAM_REJECTED'});assert.equal(f.catalogues,2);
});
test('Rate-limited renewal is bounded and honors retry delay',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.time+=61*60*1000;f.refreshStatus=429;
  await assert.rejects(f.client.get('api/movies/'),{code:'SOURCE_BUSY'});
  await assert.rejects(f.client.get('api/series/'),{code:'SOURCE_BUSY'});assert.equal(f.refreshes,1);assert.equal(f.catalogues,1);
  f.refreshStatus=0;f.time+=61*1000;await f.client.get('api/movies/');assert.equal(f.refreshes,2);
});
test('Concurrent callers retain a valid token during a temporary renewal outage',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.time+=41*60*1000;f.refreshStatus=503;
  await Promise.all(Array.from({length:5},()=>f.client.get('api/movies/')));assert.equal(f.refreshes,1);assert.equal(f.catalogues,6);
});
test('A repeatedly rejected token stops after one refresh and one retry',async()=>{
  const f=fixture();await f.client.get('api/movies/');f.rejectCatalog=20;
  await assert.rejects(f.client.get('api/movies/'),{code:'HOT_TOKEN_EXPIRED'});assert.equal(f.refreshes,1);assert.equal(f.catalogues,3);
});
test('A temporary encrypted-store write failure does not poison later session saves',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'palma-store-'));let fail=true;
  const store=createIdentityStore(directory,{isEncryptionAvailable:()=>true,encryptString:s=>{if(fail){fail=false;throw Error('temporary encryption failure');}return Buffer.from(s);},decryptString:b=>b.toString()});
  try{await assert.rejects(store.save({generation:1}));await store.save({generation:2});assert.deepEqual(await store.load(),{generation:2});}finally{await rm(directory,{recursive:true,force:true});}
});
