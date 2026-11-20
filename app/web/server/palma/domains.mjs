import {createDecipheriv} from 'node:crypto';
export const DEFAULT_BASE = 'https://nextdaywithme.shop/';
export const DEFAULT_POSTER_BASE = 'https://img.nextdaywithme.shop/';
const configURLs = ['https://raw.githubusercontent.com/MBoshkash/ostv-config/main/domains.json','https://cdn.jsdelivr.net/gh/MBoshkash/ostv-config@main/domains.json'];
// Public configuration transport key embedded in the supplied Oscar APK.
const configKey=Buffer.from('9f2c4a7e1b6d3f8c0a5e9b2d7f4c1a6e8b3d0f5c9a2e7b4d1f6c8a3e0b5d9f2c','hex');
export function httpsOrigin(value){
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/(^|\.)(local|localhost|internal)$/.test(u.hostname))throw new TypeError('Invalid API origin');
  return u.origin+'/';
}
export function decodeDomains(raw){
  let text=raw.trim();
  if(!text.startsWith('{')&&!text.startsWith('[')){
    const bytes=Buffer.from(text,'base64');if(bytes.length<29)throw new TypeError('Invalid domain configuration');
    const d=createDecipheriv('aes-256-gcm',configKey,bytes.subarray(0,12));d.setAuthTag(bytes.subarray(-16));
    text=Buffer.concat([d.update(bytes.subarray(12,-16)),d.final()]).toString('utf8');
  }
  const value=JSON.parse(text),items=Array.isArray(value)?value:[value.default_domain,...(value.backup_domains||[])];
  const origins=[...new Set(items.map(v=>{try{return httpsOrigin(v);}catch{return '';}}).filter(Boolean))].slice(0,20);
  if(!origins.length)throw new TypeError('No API origins');
  let poster=DEFAULT_POSTER_BASE;try{poster=httpsOrigin(value.poster_cdn);}catch{}
  return {origins,poster,updated:Date.now()};
}
export async function discoverDomains(fetchImpl,cached){
  if(cached?.updated>Date.now()-6*3600*1000&&cached?.origins?.length){try{return {...cached,origins:cached.origins.map(httpsOrigin),poster:httpsOrigin(cached.poster)};}catch{}}
  for(const url of configURLs){try{const r=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(6000)});if(!r.ok){await r.body?.cancel();continue;}const raw=await r.text();if(raw.length<=32768)return decodeDomains(raw);}catch{}}
  if(cached?.origins?.length){try{return {...cached,origins:cached.origins.map(httpsOrigin)};}catch{}}
  return {origins:[DEFAULT_BASE,'https://bestonecss.shop/','https://getmostjson.shop/'],poster:DEFAULT_POSTER_BASE,updated:0};
}
