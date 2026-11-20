import {createHash,createHmac,createDecipheriv,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,randomBytes,sign} from 'node:crypto';
import {requestHeaders} from './iron.mjs';
import {DEFAULT_BASE,DEFAULT_POSTER_BASE,httpsOrigin,discoverDomains} from './domains.mjs';
export {DEFAULT_BASE,DEFAULT_POSTER_BASE};
export const APP_PROFILE=Object.freeze({package_name:'com.drama.mp4',certificate_sha256:'6e2fcda8631eb49ebcba4ca8ef4c597abe84654c7d3e8096db32bdd21ecf763f',version_code:'19',version_name:'1.1.7'});
export const V3_ROUTES=Object.freeze({
  'api/movies/show.php':'api/v3/movies/show.php','api/episodes/show.php':'api/v3/episodes/show.php',
  'api/channels/show.php':'api/v3/channels/show.php','api/wrestling/show.php':'api/v3/wrestling/show.php',
  'api/matches/show.php':'api/v3/matches/show.php','api/matches/tv.php':'api/v3/matches/tv.php',
  'api/matches/event_videos.php':'api/v3/matches/event-videos.php',
});
let defaultStore;
export function configureIdentityStore(store){defaultStore=store;}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function canonicalRequest(method,url,body,ts,nonce){return [method,url.pathname,sha(url.search.slice(1)),String(ts),nonce,sha(body)].join('\n');}
export class PalmaAPIError extends Error{constructor(message,status,code){super(message);this.name='PalmaAPIError';this.status=status;this.code=code;}}
export function decryptV3(value,identity,nonce,ts){
  try{
    const iv=Buffer.from(value.iv,'base64'),tag=Buffer.from(value.tag,'base64');if(iv.length!==12||tag.length!==16)throw Error();
    const key=createHmac('sha256',Buffer.from(identity.device_secret,'hex')).update(`oscar-resp-v1|${identity.key_id}|${nonce}|${ts}`).digest();
    const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);d.setAAD(Buffer.from(value.aad,'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(value.ciphertext,'base64')),d.final()]).toString('utf8'));
  }catch{throw new PalmaAPIError('تعذر التحقق من استجابة المصدر المشفرة.',502,'INVALID_ENCRYPTED_RESPONSE');}
}
async function readJSON(response){
  const reader=response.body?.getReader();const chunks=[];let size=0;
  if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new PalmaAPIError('استجابة المصدر أكبر من الحد المسموح.',502,'RESPONSE_TOO_LARGE');}chunks.push(Buffer.from(value));}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new PalmaAPIError('أعاد المصدر استجابة غير صالحة.',response.status,'INVALID_RESPONSE');}
}
export class PalmaClient{
  constructor({base,profile=APP_PROFILE,fetchImpl=globalThis.fetch,timeout=25000,stateStore=defaultStore,now=Date.now}={}){
    this.fixedBase=base?httpsOrigin(base):null;this.base=new URL(this.fixedBase||DEFAULT_BASE);
    this.profile=profile;this.fetch=fetchImpl;this.timeout=timeout;this.store=stateStore;this.now=now;
    this.clockOffset=0;this.clockUpdated=0;this.clockPromise=null;this.identity=null;this.state={};
    this.initializing=null;this.registering=null;this.initialized=false;this.posterBase=DEFAULT_POSTER_BASE;this.origins=[this.base.href];
    this.refreshing=null;this.recovering=null;this.deviceGeneration=0;this.refreshRetryAt=0;this.refreshError=null;
  }
  async init(){
    if(this.initialized)return;
    if(!this.initializing)this.initializing=(async()=>{
      this.state=(await this.store?.load())||{};const existing=this.state.identity;
      try{if(existing?.private_key&&existing?.device_id){const key=createPrivateKey(existing.private_key),pub=createPublicKey(key);if(key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw Error();const keyId=sha(pub.export({type:'spki',format:'der'}));if(existing.key_id&&existing.key_id!==keyId)throw Error();this.identity={...existing,key_id:keyId,public_key:pub.export({type:'spki',format:'pem'})};}}catch{}
      if(!this.identity){const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});this.identity={device_id:randomUUID(),private_key:privateKey.export({type:'pkcs8',format:'pem'}),public_key:publicKey.export({type:'spki',format:'pem'}),key_id:sha(publicKey.export({type:'spki',format:'der'}))};}
      if(!this.fixedBase){const domains=await discoverDomains(this.fetch,this.state.domains);this.state.domains=domains;this.origins=domains.origins;this.base=new URL(this.origins[0]);this.posterBase=domains.poster;}
      await this.save();this.initialized=true;
    })().finally(()=>{this.initializing=null;});return this.initializing;
  }
  async save(){this.state.identity=this.identity;await this.store?.save(this.state);}
  serverNow(){return Math.floor(this.now()/1000)+this.clockOffset;}
  updateClock(response){const server=response.headers.get('X-Server-Time'),date=server&&/^\d+$/.test(server)?Number(server)*1000:Date.parse(response.headers.get('date'));if(Number.isFinite(date)){this.clockOffset=Math.floor(date/1000)-Math.floor(this.now()/1000);this.clockUpdated=this.now();}}
  async syncClock(){
    if(this.clockUpdated>this.now()-300000)return;
    if(!this.clockPromise)this.clockPromise=(async()=>{const r=await this.fetch(new URL('api/ping.php',this.base),{headers:{'User-Agent':'okhttp/4.12.0'},redirect:'error',signal:AbortSignal.timeout(Math.min(this.timeout,6000))});this.updateClock(r);await r.body?.cancel();})().finally(()=>{this.clockPromise=null;});await this.clockPromise.catch(()=>{});
  }
  async enroll(){
    if(this.identity?.device_secret)return;
    if(!this.registering)this.registering=(async()=>{
      // Owner-authorized port of the supplied client's software EC fallback.
      // Only the public APK certificate identity is used, never its signing key
      // or a forged hardware-attestation certificate chain.
      await this.perform('api/v3/devices/challenge.php',{}, {device_id:this.identity.device_id},false).catch(e=>{if(e.status===429)throw e;});
      const fingerprint=this.profile.certificate_sha256;
      const attest=JSON.stringify({file:fingerprint,raw:fingerprint,pm:fingerprint,hook:0,acf:'ok'});
      const {body:value}=await this.perform('api/v3/devices/register.php',{}, {device_id:this.identity.device_id,public_key:this.identity.public_key,platform:'android',app_version:this.profile.version_name,attest},false);
      if(value.key_id!==this.identity.key_id||!/^([a-f0-9]{2}){16,64}$/.test(value.device_secret||''))throw new PalmaAPIError('رفض المصدر تسجيل الجهاز.',403,'DEVICE_REGISTRATION_FAILED');
      Object.assign(this.identity,{device_secret:value.device_secret,hot_token:value.hot_token,hot_exp:value.hot_exp,hot_ttl:Math.max(0,Number(value.hot_exp)-this.serverNow()),trust:value.trust});this.deviceGeneration++;await this.save();
    })().finally(()=>{this.registering=null;});return this.registering;
  }
  hotUsable(){return /^[a-f0-9]{32,}$/.test(this.identity?.hot_token||'')&&Number(this.identity.hot_exp)>this.serverNow()+120;}
  hotFresh(){const ttl=Number(this.identity?.hot_ttl)||0;const margin=ttl>0?Math.min(1800,Math.max(120,ttl/3)):1800;return this.hotUsable()&&Number(this.identity.hot_exp)>this.serverNow()+margin;}
  async recoverDevice(generation=this.deviceGeneration){
    if(generation!==this.deviceGeneration)return;
    if(!this.recovering)this.recovering=(async()=>{
      for(const key of ['device_secret','hot_token','hot_exp','hot_ttl'])delete this.identity[key];
      await this.enroll();
    })().finally(()=>{this.recovering=null;});
    return this.recovering;
  }
  async refreshHotToken({force=false,rejectedToken}={}){
    if(rejectedToken&&rejectedToken!==this.identity.hot_token&&this.hotUsable())return;
    if(!force&&this.hotFresh())return;
    if(this.refreshing){try{await this.refreshing;}catch(error){if(force||!this.hotUsable())throw error;}return;}
    if(this.refreshRetryAt>this.now()){
      if(!force&&this.hotUsable())return;
      throw this.refreshError||new PalmaAPIError('تعذر تجديد الجلسة الآن. أعد المحاولة بعد قليل.',503,'SESSION_REFRESH_FAILED');
    }
    this.refreshing=(async()=>{
      try{
        const generation=this.deviceGeneration;
        let result;
        try{result=await this.perform('api/v3/devices/token.php',{},undefined,true,'POST');}
        catch(error){
          if(error.code!=='UNKNOWN_DEVICE')throw error;
          await this.recoverDevice(generation);
          if(this.hotFresh())return;
          result=await this.perform('api/v3/devices/token.php',{},undefined,true,'POST');
        }
        const value=result.body,exp=Number(value.hot_exp),ttl=Number(value.ttl);
        if(!/^[a-f0-9]{32,}$/.test(value.hot_token||'')||!Number.isSafeInteger(exp)||exp<=this.serverNow()+120)throw new PalmaAPIError('أعاد المصدر جلسة غير صالحة. أعد المحاولة بعد قليل.',502,'INVALID_SESSION_REFRESH');
        Object.assign(this.identity,{hot_token:value.hot_token,hot_exp:exp,hot_ttl:Number.isFinite(ttl)&&ttl>0?ttl:exp-this.serverNow()});
        await this.save();this.refreshError=null;
      }catch(error){this.refreshError=error;throw error;}
      finally{this.refreshRetryAt=this.now()+Math.max(20000,(this.refreshError?.retryAfter||0)*1000);}
    })().finally(()=>{this.refreshing=null;});
    try{await this.refreshing;}catch(error){if(force||!this.hotUsable())throw error;}
  }
  async perform(route,query={},body,signed=false,methodOverride){
    const url=new URL(route,this.base);for(const [key,value]of Object.entries(query))if(value!=null)url.searchParams.set(key,String(value));
    const method=methodOverride||(body===undefined?'GET':'POST'),bytes=body===undefined?'':JSON.stringify(body),started=this.now();
    for(let attempt=0;attempt<2;attempt++){
      const ts=String(this.serverNow()),nonce=randomBytes(32).toString('base64url');
      const headers={...requestHeaders(this.profile,url.pathname,ts),'User-Agent':'okhttp/4.12.0',Accept:'application/json','X-Device-Id':this.identity.device_id};
      if(method==='POST')headers['Content-Type']='application/json; charset=UTF-8';
      if(signed)Object.assign(headers,{'X-Key-Id':this.identity.key_id,'X-Sig-V3':'ecdsa='+sign('sha256',Buffer.from(canonicalRequest(method,url,bytes,ts,nonce)),this.identity.private_key).toString('base64'),'X-V3-Ts':ts,'X-V3-Nonce':nonce,'X-Encrypt-Response':'1'});
      else if(!route.startsWith('api/v3/')&&/^[a-f0-9]{32,}$/.test(this.identity.hot_token||'')&&Number(this.identity.hot_exp)>Number(ts)+120){const n=randomBytes(16).toString('base64url');Object.assign(headers,{'X-Key-Id':this.identity.key_id,'X-D-Sig':createHmac('sha256',Buffer.from(this.identity.hot_token,'hex')).update(canonicalRequest(method,url,bytes,ts,n)).digest('hex'),'X-D-Ts':ts,'X-D-Nonce':n,'X-HT-Exp':String(this.identity.hot_exp),'X-App-Ver':this.profile.version_code});}
      const response=await this.fetch(url,{method,headers,body:method==='POST'?bytes:undefined,redirect:'error',signal:AbortSignal.timeout(this.timeout)});this.updateClock(response);
      const reason=response.headers.get('X-V3-Reason'),hotReason=response.headers.get('X-Hot-Reason');
      if(response.status===403&&(reason==='bad_ts'||hotReason==='bad_ts')&&attempt===0){await response.body?.cancel();continue;}
      if(!response.ok){
        await response.body?.cancel();
        const code=reason==='unknown_key'?'UNKNOWN_DEVICE':response.status===429?'SOURCE_BUSY':!signed&&[401,403].includes(response.status)&&/token/i.test(hotReason||'')?'HOT_TOKEN_EXPIRED':route.endsWith('register.php')?'DEVICE_REGISTRATION_FAILED':'UPSTREAM_REJECTED';
        const error=new PalmaAPIError('رفض المصدر الطلب؛ أعد المحاولة لاحقًا.',response.status,code);
        const retry=Number(response.headers.get('Retry-After'));if(Number.isFinite(retry)&&retry>0)error.retryAfter=Math.min(300,retry);
        throw error;
      }
      let value=await readJSON(response);if(response.headers.get('X-Content-Encrypted')?.toUpperCase()==='AES-256-GCM')value=decryptV3(value,this.identity,nonce,ts);
      if(!response.ok||value?.status==='error'){const code=reason==='unknown_key'?'UNKNOWN_DEVICE':response.status===429?'SOURCE_BUSY':route.endsWith('register.php')?'DEVICE_REGISTRATION_FAILED':'UPSTREAM_REJECTED';throw new PalmaAPIError('رفض المصدر الطلب؛ أعد المحاولة لاحقًا.',response.status,code);}
      return {body:value,status:response.status,elapsed_ms:this.now()-started};
    }
    throw new PalmaAPIError('تعذر مزامنة وقت المصدر.',502,'CLOCK_SYNC_FAILED');
  }
  async request(route,query={},body){
    if(!/^api\/[A-Za-z0-9_./-]+$/.test(route)||route.split('/').includes('..'))throw new TypeError('Invalid PALMA API route');
    await this.init();await this.syncClock();const signed=route.startsWith('api/v3/');await this.enroll();
    if(!signed)await this.refreshHotToken();
    for(let attempt=0;attempt<2;attempt++){
      const sentToken=this.identity.hot_token,generation=this.deviceGeneration;
      try{return await this.perform(route,query,body,signed);}catch(error){
      if(attempt===0&&signed&&error.code==='UNKNOWN_DEVICE'){await this.recoverDevice(generation);continue;}
      if(attempt===0&&!signed&&error.code==='HOT_TOKEN_EXPIRED'){await this.refreshHotToken({force:true,rejectedToken:sentToken});continue;}
      if(attempt===0&&!this.fixedBase&&!(error instanceof PalmaAPIError)&&this.origins.length>1){this.base=new URL(this.origins[(this.origins.indexOf(this.base.href)+1)%this.origins.length]);this.clockUpdated=0;await this.syncClock();continue;}throw error;
      }
    }
  }
  async get(route,query={}){query={...query};if(['api/v2/home.php','api/series/','api/movies/','api/episodes/','api/content-categories.php','api/series/filters.php','api/search/all.php'].includes(route))query.app_version=this.profile.version_code;return this.request(V3_ROUTES[route]||route,query);}
  async resolveLink({t,cid,k,lid}){if(!['movie','episode','channel','wrestling','match_video'].includes(t)||!['watch','download'].includes(k)||![cid,lid].every(x=>Number.isSafeInteger(x)&&x>0))throw new TypeError('Invalid playback selection');return this.request('api/v3/resolve.php',{}, {t,cid,k,lid});}
}
