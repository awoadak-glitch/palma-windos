import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256,inspectArchive,validVersion,compareVersions,MAX_ARCHIVE} from './update-contract.mjs';

// Electron must supply original-fs here: .asar files are ordinary bytes to this store.
export function createUpdateStore({fs,root,bundledVersion}){
  const stateFile=path.join(root,'state.json');
  fs.mkdirSync(root,{recursive:true});
  const empty=()=>({schema:1,current:null,previous:null,pending:null,attempt:null,lastError:''});
  function read(){try{if(fs.statSync(stateFile).size>65536)throw Error();const value=JSON.parse(fs.readFileSync(stateFile,'utf8'));return value?.schema===1?{...empty(),...value}:empty();}catch{return empty();}}
  function write(value){
    const temporary=stateFile+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(temporary,stateFile);}finally{try{fs.unlinkSync(temporary);}catch{}}
  }
  function fileFor(record){
    if(!record||!validVersion(record.version)||! /^[a-f0-9]{64}$/.test(record.sha256)||!Number.isSafeInteger(record.size)||record.size<1||record.size>MAX_ARCHIVE)throw Error('سجل تحديث غير صالح.');
    return path.join(root,record.sha256+'.asar');
  }
  function verified(record){
    const file=fileFor(record),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.size)throw Error('ملف التحديث مفقود أو ناقص.');
    const bytes=fs.readFileSync(file);
    if(sha256(bytes)!==record.sha256)throw Error('تعذر التحقق من سلامة التحديث.');
    inspectArchive(bytes,record.version);return file;
  }
  function stage(record){verified(record);const state=read();state.pending=record;state.attempt=null;state.lastError='';write(state);}
  function select(){
    const state=read();let changed=false,selected=null,trial=false;
    if(state.pending&&state.attempt){state.pending=null;state.attempt=null;state.lastError='تعذر بدء التحديث السابق؛ تمت العودة إلى النسخة السابقة.';changed=true;}
    if(state.pending){
      try{
        const floor=state.current?.version&&compareVersions(state.current.version,bundledVersion)>0?state.current.version:bundledVersion;
        if(compareVersions(state.pending.version,floor)<=0)throw Error();
        selected={...state.pending,file:verified(state.pending)};trial=true;state.attempt={sha256:state.pending.sha256};changed=true;
      }catch{state.pending=null;state.attempt=null;state.lastError='حزمة التحديث غير مكتملة؛ استُخدمت النسخة السابقة.';changed=true;}
    }
    if(!selected){
      for(const record of [state.current,state.previous]){
        if(!record)continue;
        try{if(compareVersions(record.version,bundledVersion)<=0)continue;selected={...record,file:verified(record)};if(record!==state.current){state.current=record;state.previous=null;state.lastError='تمت استعادة النسخة السابقة بعد تلف ملف التحديث.';changed=true;}break;}catch{changed=true;}
      }
      if(!selected&&state.current){state.current=null;state.previous=null;changed=true;}
    }
    if(changed)write(state);
    return {version:selected?.version||bundledVersion,record:selected,trial,lastError:state.lastError};
  }
  function prune(state){
    const keep=new Set([state.current,state.previous,state.pending].filter(Boolean).map(r=>r.sha256+'.asar'));
    for(const name of fs.readdirSync(root))if(/^[a-f0-9]{64}\.asar$/.test(name)&&!keep.has(name))try{fs.unlinkSync(path.join(root,name));}catch{}
  }
  function confirm(record){const state=read();if(!record||state.pending?.sha256!==record.sha256||state.attempt?.sha256!==record.sha256)return;state.previous=state.current;state.current=state.pending;state.pending=null;state.attempt=null;state.lastError='';write(state);prune(state);}
  function reject(record){const state=read();if(state.pending?.sha256===record?.sha256){state.pending=null;state.attempt=null;state.lastError='تعذر تشغيل التحديث؛ تمت العودة إلى النسخة السابقة.';write(state);}}
  return {root,read,write,fileFor,verified,stage,select,confirm,reject};
}
