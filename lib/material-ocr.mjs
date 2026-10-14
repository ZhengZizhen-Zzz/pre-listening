import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const run=promisify(execFile), root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=process.env.OCR_PYTHON || 'python3';
const script=path.join(root,'scripts/ocr-page.py');
const cache=new Map();
let active=false;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export async function ocrAvailable(){
  if(process.platform!=='darwin')return false;
  try{const {stdout}=await run(python,[script,'--probe'],{timeout:15000});return JSON.parse(stdout).available===true;}catch{return false;}
}
export function validateOcrImage(bytes){
  if(!bytes.length || bytes.length>8*1024*1024)fail('页面图片过大，请缩小后重试。');
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && !(bytes[0]===255&&bytes[1]===216&&bytes[2]===255))fail('页面图片格式不支持。');
}
export async function recognizePage(bytes,runner=run){
  validateOcrImage(bytes);
  const key=createHash('sha256').update(bytes).digest('hex');
  if(cache.has(key))return {...cache.get(key),cacheHit:true};
  if(active)fail('正在读取另一页，请稍后重试。',409);
  active=true;let dir;
  try{
    dir=await mkdtemp(path.join(tmpdir(),'rehearsal-ocr-'));const file=path.join(dir,'page.image');await writeFile(file,bytes);
    const {stdout}=await runner(python,[script,file],{timeout:30000,maxBuffer:1024*1024});
    const result=JSON.parse(stdout);
    if(typeof result.text!=='string' || !Number.isFinite(result.confidence))fail('本页文字尚未读取成功。',502);
    const output={text:result.text.slice(0,12000),textSource:'ocr',confidence:result.confidence};
    if(cache.size>=80)cache.delete(cache.keys().next().value);cache.set(key,output);
    return output;
  }catch(error){if(error.status)throw error;fail('本页文字识别暂时不可用，可稍后重试。',503);}
  finally{active=false;if(dir)await rm(dir,{recursive:true,force:true});}
}
