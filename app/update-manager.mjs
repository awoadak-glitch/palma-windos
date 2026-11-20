import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {APP_ORIGIN} from './bridge.mjs';
import {repositoryName,manifestURL,validateManifest,compareVersions,sha256,inspectArchive,MAX_ARCHIVE} from './update-contract.mjs';

const assetHosts=new Set(['release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
export function allowedUpdateURL(raw,repo){
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash)throw Error('عنوان تحديث غير مسموح.');
  if(u.hostname==='github.com'){
    if(!u.pathname.startsWith('/'+repositoryName(repo)+'/releases/'))throw Error('مصدر التحديث لا يطابق المستودع المحدد.');
  }else if(!assetHosts.has(u.hostname))throw Error('أعاد GitHub توجيهًا إلى مصدر تحديث غير مسموح.');
  return u.href;
}
export async function fetchUpdate(raw,repo,{fetchImpl=fetch,signal}={}){
  let url=allowedUpdateURL(raw,repo);
  for(let i=0;i<6;i++){
    const response=await fetchImpl(url,{redirect:'manual',headers:{'User-Agent':'PALMA-VISION-Updater','Accept':'application/octet-stream'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000)});
    if([301,302,303,307,308].includes(response.status)){
      const next=response.headers.get('location');await response.body?.cancel();
      if(!next)throw Error('رابط تنزيل التحديث غير مكتمل.');
      url=allowedUpdateURL(new URL(next,url).href,repo);continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error(response.status===404?'لم يُنشر تحديث عام في هذا المستودع بعد، أو أن المستودع خاص.':response.status===429?'طلب GitHub الانتظار قليلًا. حاول لاحقًا.':'تعذر تنزيل التحديث من GitHub ('+response.status+').');}
    return response;
  }
  throw Error('تعذر الوصول إلى ملف التحديث.');
}
async function collect(response,limit,onProgress=()=>{},signal){
  const advertised=response.headers.get('content-length');
  if(advertised!==null&&Number(advertised)>limit){await response.body?.cancel();throw Error('ملف التحديث أكبر من الحجم المتوقع.');}
  if(!response.body)throw Error('ملف التحديث فارغ.');
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try{
    while(true){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>limit)throw Error('حجم ملف التحديث لا يطابق المعلومات المنشورة.');parts.push(Buffer.from(value));onProgress(bytes);}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  return Buffer.concat(parts);
}

export function createUpdateManager({fs,store,version,defaultRepository='',fetchImpl=fetch,restart=()=>{},canRestart=()=>true,onReady=()=>{},startupMessage=''}){
  const configPath=path.join(store.root,'repository.json');
  let repo='';
  try{if(fs.statSync(configPath).size<2048)repo=repositoryName(JSON.parse(fs.readFileSync(configPath,'utf8')).repository);}catch{}
  if(!repo&&defaultRepository)try{repo=repositoryName(defaultRepository);}catch{}
  let phase='idle',error='',available=null,bytes=0,total=0,job=null,controller=null,restarting=false;
  const status=()=>({version,repository:repo,configured:Boolean(repo),phase,error,available:available?{version:available.version,notes:available.notes,size:available.size}:null,bytes,total,pending:store.read().pending?.version||null,startupMessage});
  function configure(value){
    if(job||store.read().pending)throw Error('أكمل التحديث الجاري قبل تغيير المستودع.');
    const name=repositoryName(value),tmp=configPath+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(tmp,JSON.stringify({repository:name}),{flag:'wx',mode:0o600});fs.renameSync(tmp,configPath);}finally{try{fs.unlinkSync(tmp);}catch{}}
    repo=name;available=null;error='';phase='idle';return status();
  }
  async function check(){
    if(job)return status();
    if(!repo)throw Error('أدخل مستودع تحديثات بالما أولًا.');
    if(store.read().pending)return status();
    phase='checking';error='';available=null;controller=new AbortController();
    const signal=controller.signal;
    job=(async()=>{
      try{
        const response=await fetchUpdate(manifestURL(repo),repo,{fetchImpl,signal});
        const buffer=await collect(response,65536,undefined,signal);
        let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{throw Error('ملف معلومات التحديث غير صالح.');}
        const manifest=validateManifest(value,repo);
        if(compareVersions(manifest.version,version)>0){available=manifest;phase='available';}else phase='current';
      }catch(e){phase='error';error=e.name==='AbortError'?'أُلغي فحص التحديث.':e.message;}
      finally{controller=null;job=null;}
    })();
    await job;return status();
  }
  function download(){
    if(job)return status();
    if(!available||compareVersions(available.version,version)<=0)throw Error('تحقق من وجود تحديث جديد أولًا.');
    const manifest=available,repository=repo;
    phase='downloading';error='';bytes=0;total=manifest.size;controller=new AbortController();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(5*60*1000)]);
    job=(async()=>{
      let temporary;
      try{
        const response=await fetchUpdate(manifest.url,repository,{fetchImpl,signal});
        const compressed=await collect(response,manifest.size,n=>{bytes=n;},signal);
        if(compressed.length!==manifest.size||sha256(compressed)!==manifest.sha256)throw Error('فشل التحقق من سلامة التنزيل؛ بقيت نسختك الحالية كما هي.');
        phase='verifying';signal.throwIfAborted();
        let archive;try{archive=gunzipSync(compressed,{maxOutputLength:Math.min(MAX_ARCHIVE,manifest.unpackedSize)});}catch{throw Error('تعذر فك حزمة التحديث.');}
        if(archive.length!==manifest.unpackedSize||sha256(archive)!==manifest.unpackedSha256)throw Error('حزمة التحديث لا تطابق البصمة المنشورة.');
        inspectArchive(archive,manifest.version);
        const record={version:manifest.version,sha256:manifest.unpackedSha256,size:archive.length},destination=store.fileFor(record);
        temporary=path.join(store.root,randomUUID()+'.partial');
        await fs.promises.writeFile(temporary,archive,{flag:'wx',mode:0o600});signal.throwIfAborted();
        await fs.promises.rename(temporary,destination);temporary=null;store.stage(record);phase='ready';
      }catch(e){phase='error';error=e.name==='AbortError'?'أُلغي تنزيل التحديث؛ يمكنك إعادة المحاولة.':e.message;}
      finally{if(temporary)await fs.promises.rm(temporary,{force:true}).catch(()=>{});controller=null;job=null;}
    })();
    return status();
  }
  async function handle(request){
    const u=new URL(request.url);
    if(u.origin!=='null'&&u.origin!==APP_ORIGIN)return Response.json({error:'طلب غير مسموح.'},{status:403});
    if(u.protocol!=='palma:'||u.host!=='app'||u.username||u.password||u.pathname!=='/api/desktop/updates'||request.initiatorOrigin!==APP_ORIGIN)return Response.json({error:'طلب غير مسموح.'},{status:403});
    const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
    if(request.method==='GET')return reply(status());
    if(request.method!=='POST')return reply({error:'طريقة غير مدعومة.'},405);
    try{
      const text=await request.text();if(text.length>2048)throw Error('طلب تحديث غير صالح.');const body=JSON.parse(text);
      if(body.action==='ready'){onReady();return reply({ok:true});}
      if(body.action==='configure')return reply(configure(body.repository));
      if(body.action==='check')return reply(await check());
      if(body.action==='download')return reply(download());
      if(body.action==='cancel'){controller?.abort();return reply(status());}
      if(body.action==='restart'){
        if(restarting)return reply({restarting:true});
        if(job||!store.read().pending)throw Error('لا يوجد تحديث جاهز للتثبيت.');
        if(!canRestart())throw Error('أكمل تنزيلات الفيديو أو ألغها قبل إعادة التشغيل.');
        restarting=true;setTimeout(()=>restart(),200);return reply({restarting:true});
      }
      throw Error('إجراء تحديث غير صالح.');
    }catch(e){return reply({error:e.message},400);}
  }
  return {status,configure,check,download,handle,settled:async()=>{await job;},shutdown:async()=>{controller?.abort();await job;}};
}
