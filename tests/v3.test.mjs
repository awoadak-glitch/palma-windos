import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,createCipheriv,verify,createPublicKey,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import {PalmaClient,canonicalRequest,decryptV3} from '../app/web/server/palma/client.mjs';
import {decodeDomains,httpsOrigin} from '../app/web/server/palma/domains.mjs';
import {createResolver} from '../app/web/api/resolve.js';
import {invokeHandler} from '../app/bridge.mjs';
import {playbackSource} from '../app/web/server/source.js';
import {mediaHeadersForURL} from '../app/web/server/source-session.js';
import {ticket,unticket} from '../app/web/server/http.js';

test('Concurrent V3 calls register one device, sign exact request and decode authentic GCM',async()=>{
  let state,publicKey,keyId,registrations=0;const secret='ab'.repeat(32),hot='cd'.repeat(32),now=Math.floor(Date.now()/1000);
  const fetchImpl=async(url,options)=>{
    const u=new URL(url),h=options.headers;
    if(u.pathname.endsWith('ping.php'))return new Response('',{headers:{date:new Date().toUTCString()}});
    if(u.pathname.endsWith('challenge.php'))return Response.json({status:'success',challenge:'AA==',ttl:60});
    if(u.pathname.endsWith('register.php')){
      registrations++;const body=JSON.parse(options.body);assert.equal(body.platform,'android');assert.equal(body.app_version,'1.1.7');
      publicKey=createPublicKey(body.public_key);keyId=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
      assert.equal(body.attest.includes('-----BEGIN'),false);
      return Response.json({status:'success',key_id:keyId,device_secret:secret,hot_token:hot,hot_exp:now+3600,trust:'basic'});
    }
    assert.equal(h['X-Key-Id'],keyId);
    if(u.pathname.startsWith('/api/v3/')){
      const expected=['GET',u.pathname,createHash('sha256').update(u.search.slice(1)).digest('hex'),h['X-V3-Ts'],h['X-V3-Nonce'],createHash('sha256').update('').digest('hex')].join('\n');
      assert.ok(verify('sha256',Buffer.from(expected),publicKey,Buffer.from(h['X-Sig-V3'].slice(6),'base64')));
      const k=createHmac('sha256',Buffer.from(secret,'hex')).update(`oscar-resp-v1|${keyId}|${h['X-V3-Nonce']}|${h['X-V3-Ts']}`).digest();
      const iv=randomBytes(12),aad=Buffer.from('server-response'),c=createCipheriv('aes-256-gcm',k,iv);c.setAAD(aad);
      const bytes=Buffer.concat([c.update(JSON.stringify({status:'success',data:{id:7,watch_links:[{id:99}]}})),c.final()]);
      return Response.json({iv:iv.toString('base64'),aad:aad.toString('base64'),tag:c.getAuthTag().toString('base64'),ciphertext:bytes.toString('base64')},{headers:{'X-Content-Encrypted':'AES-256-GCM'}});
    }
    const expected=createHmac('sha256',Buffer.from(hot,'hex')).update(canonicalRequest('GET',u,'',h['X-D-Ts'],h['X-D-Nonce'])).digest('hex');assert.equal(h['X-D-Sig'],expected);
    return Response.json({status:'success',data:[]});
  };
  const store={load:async()=>state,save:async x=>{state=structuredClone(x);}};
  const client=new PalmaClient({base:'https://source.example/',fetchImpl,stateStore:store});
  const all=await Promise.all([client.get('api/movies/show.php',{id:7}),client.get('api/episodes/show.php',{id:8})]);
  assert.equal(registrations,1);assert.equal(all[0].body.data.watch_links[0].id,99);
  await client.get('api/movies/',{page:1});
  const reopened=new PalmaClient({base:'https://source.example/',fetchImpl,stateStore:store});await reopened.get('api/movies/show.php',{id:7});assert.equal(registrations,1);
});
test('Corrupt GCM response is rejected',()=>assert.throws(()=>decryptV3({iv:'AA==',tag:'AA=='},{device_secret:'aa'.repeat(32)},'n','1'),{code:'INVALID_ENCRYPTED_RESPONSE'}));
test('Published domain file decrypts and excludes insecure origins',async()=>{
  const domains=decodeDomains(await fs.readFile(new URL('./domains.json',import.meta.url),'utf8'));assert.ok(domains.origins.length>1);assert.equal(domains.origins[0],'https://nextdaywithme.shop/');
  assert.throws(()=>httpsOrigin('http://example.com/'));assert.throws(()=>httpsOrigin('https://user:pass@example.com/'));
});
for(const c of [
  {kind:'movie',id:'10',links:'watch_links',t:'movie',cid:10,k:'watch'},
  {kind:'series',id:'10',episode:'22',links:'watch_links',t:'episode',cid:22,k:'watch'},
  {kind:'movie',id:'10',download:'1',links:'download_links',t:'movie',cid:10,k:'download'},
  {kind:'channel',id:'10',links:'streams',t:'channel',cid:10,k:'watch'},
  {kind:'wrestling',id:'10',links:'watch_links',t:'wrestling',cid:10,k:'watch'},
  {kind:'match-video',id:'31',match_id:'44',t:'match_video',cid:44,k:'watch'},
])test('V3 resolver selects actual link id: '+c.kind+' '+c.k,async()=>{
  let actual;const id=c.kind==='match-video'?31:998;
  const handler=createResolver({getCatalogue:async()=>({data:c.kind==='match-video'?[{id}]:{[c.links]:[{id}]}}),getPalmaLink:async request=>{actual=request;return {url:'https://video.example/film.mp4'};},getMedia:async()=>({type:'video',playable:'verified'})});
  const q=new URLSearchParams({provider:'palma',kind:c.kind,id:c.id,index:'0',...(c.episode?{episode:c.episode}:{}),...(c.download?{download:c.download}:{}),...(c.match_id?{match_id:c.match_id}:{})});
  const r=await invokeHandler(handler,new Request('palma://app/api/resolve?'+q));assert.equal(r.status,200);assert.deepEqual(actual,{t:c.t,cid:c.cid,k:c.k,lid:id});
});
test('Independent anime flow never requests Oscar V3',async()=>{
  const handler=createResolver({getCatalogue:async(_p,_r,q)=>q?.resolve!==undefined?{url:'https://anime.example/episode.mp4',quality:'720p'}:{items:[{name:'Anime'}]},getPalmaLink:async()=>{throw Error('must not be called');},getMedia:async()=>({type:'video'})});
  const r=await invokeHandler(handler,new Request('palma://app/api/resolve?provider=witcher&kind=anime&id=one&episode=2&index=0'));assert.equal(r.status,200);
});
test('Playback cookie stays confined through encrypted tickets',()=>{
  const deep='tdmvideo://play?'+new URLSearchParams({url:'https://source-media.example/video.m3u8',cookies:'ot=test-only; other=discard',ua:'source-player'});
  const s=playbackSource({deep_link:deep},{provider:'palma'});assert.equal(s.headers.Cookie,'ot=test-only');
  assert.equal(mediaHeadersForURL('https://unrelated.example/file',s.headers).Cookie,undefined);
  const encoded=ticket(s.url,s.headers);assert.equal(encoded.includes('test-only'),false);
  assert.equal(unticket(encoded).h.Cookie,'ot=test-only');
});
