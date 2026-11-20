import {createHash} from 'node:crypto';

export const UPDATE_OWNER='awoadak-glitch';
export const UPDATE_REPOSITORY=UPDATE_OWNER+'/palma-windos';
export const UPDATE_RUNTIME='palma-win-x64-v1';
export const BOOTSTRAP_VERSION=1;
export const MAX_ARCHIVE=32*1024*1024;
export const MAX_DOWNLOAD=12*1024*1024;
const versionPattern=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export function validVersion(value){return typeof value==='string'&&versionPattern.test(value);}
export function compareVersions(a,b){
  if(!validVersion(a)||!validVersion(b))throw Error('رقم إصدار غير صالح.');
  const x=a.split('.').map(Number),y=b.split('.').map(Number);
  for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);
  return 0;
}
export function repositoryName(value){
  let text=String(value||'').trim();
  if(text.startsWith('https://')){
    const u=new URL(text);
    if(u.hostname!=='github.com'||u.port||u.username||u.password||u.search||u.hash)throw Error('أدخل رابط مستودع GitHub الصحيح.');
    text=u.pathname.replace(/^\/|\/$/g,'');
  }
  const parts=text.split('/');
  if(parts.length!==2||parts[0]!==UPDATE_OWNER||! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(parts[1])||parts[1].endsWith('.git'))throw Error('اختر مستودعًا ضمن حساب '+UPDATE_OWNER+'.');
  return text;
}
export const manifestURL=repo=>`https://github.com/${repositoryName(repo)}/releases/latest/download/palma-update.json`;
export function validateManifest(value,repo){
  const fail=()=>{throw Error('ملف معلومات التحديث غير صالح أو غير متوافق مع هذه النسخة.');};
  if(!value||value.schema!==1||value.app!=='com.palma.vision.desktop'||!validVersion(value.version)||value.runtime!==UPDATE_RUNTIME||!Number.isInteger(value.minBootstrap)||value.minBootstrap<1||value.minBootstrap>BOOTSTRAP_VERSION)fail();
  const download=`https://github.com/${repositoryName(repo)}/releases/download/v${value.version}/PALMA-VISION-${value.version}.asar.gz`;
  if(value.url!==download||!Number.isSafeInteger(value.size)||value.size<1||value.size>MAX_DOWNLOAD||!Number.isSafeInteger(value.unpackedSize)||value.unpackedSize<1||value.unpackedSize>MAX_ARCHIVE||! /^[a-f0-9]{64}$/.test(value.sha256)||! /^[a-f0-9]{64}$/.test(value.unpackedSha256))fail();
  return {...value,notes:typeof value.notes==='string'?value.notes.slice(0,4000):''};
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

// Parse the packaged application's metadata without executing downloaded code.
export function inspectArchive(bytes,expectedVersion){
  if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.length>MAX_ARCHIVE)throw Error('حزمة التحديث غير صالحة.');
  const headerSize=bytes.readUInt32LE(4),jsonSize=bytes.readUInt32LE(12),base=8+headerSize;
  if(bytes.readUInt32LE(0)!==4||headerSize<8||headerSize>2*1024*1024||jsonSize<2||jsonSize>headerSize-8||base>bytes.length)throw Error('رأس حزمة التحديث غير صالح.');
  let header;try{header=JSON.parse(bytes.subarray(16,16+jsonSize).toString('utf8'));}catch{throw Error('رأس حزمة التحديث غير صالح.');}
  const files=header?.files;
  function entry(name){
    const item=files?.[name];
    if(!item||item.link||item.unpacked||!Number.isSafeInteger(item.size)||item.size<1||! /^\d+$/.test(item.offset))throw Error('حزمة التحديث غير مكتملة.');
    const start=base+Number(item.offset),end=start+item.size;
    if(!Number.isSafeInteger(start)||start<base||end>bytes.length)throw Error('حزمة التحديث غير مكتملة.');
    return bytes.subarray(start,end);
  }
  let pkg;try{pkg=JSON.parse(entry('package.json').toString('utf8'));}catch{throw Error('بيانات التطبيق في التحديث غير صالحة.');}
  if(pkg.name!=='palma-vision'||pkg.type!=='module'||pkg.main!=='bootstrap.mjs'||pkg.version!==expectedVersion)throw Error('التحديث لا يطابق تطبيق بالما أو رقم الإصدار.');
  entry('main.mjs');entry('bootstrap.mjs');
  return pkg;
}
