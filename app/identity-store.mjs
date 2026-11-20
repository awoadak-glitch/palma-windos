import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
export function createIdentityStore(directory,safeStorage){
  const target=path.join(directory,'source-identity-v3.bin');let queue=Promise.resolve();
  return {
    async load(){try{return JSON.parse(safeStorage.decryptString(await readFile(target)));}catch(e){if(e.code==='ENOENT')return null;throw new Error('تعذر قراءة هوية الجهاز المحفوظة. شغّل بالما من حساب ويندوز نفسه.');}},
    save(state){const text=JSON.stringify(state);queue=queue.catch(()=>{}).then(async()=>{if(!safeStorage.isEncryptionAvailable())throw new Error('خدمة حماية بيانات ويندوز غير متاحة.');await mkdir(directory,{recursive:true});const temp=target+'.tmp';await writeFile(temp,safeStorage.encryptString(text),{mode:0o600});await rename(temp,target);});return queue;},
  };
}
