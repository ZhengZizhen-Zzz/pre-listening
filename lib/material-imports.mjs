import { mkdir, readdir, rm, writeFile, readFile, rename, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { UPLOAD_CHUNK_BYTES, MAX_UPLOAD_CHUNK_BYTES, MAX_PREVIEW_BYTES, INLINE_UPLOAD_BYTES, PREVIEW_WAIT_MS, validateMaterialSize } from '../public/material-limits.mjs';
import { validateOfficeFile } from './office-import.mjs';

const fault=(message,status=400,code='invalid_upload')=>Object.assign(new Error(message),{status,code});
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL=new Set(['complete','failed']);
const CODES=new Set(['complete','conversion_failed','conversion_timeout','conversion_no_output','converter_unavailable','invalid_format','protected_or_mislabeled','invalid_preview','preview_too_large','upload_failed','network_error','expired','pdf_password','pdf_invalid','page_limit','browser_unsupported','render_memory','render_conflict','render_resource','preview_failed','server_error','storage_error']);

export class MaterialImports {
  constructor({directory,convert,now=Date.now,ttl=30*60*1000,chunkBytes=UPLOAD_CHUNK_BYTES,maxJobs=8,maxReserved=3*1024**3}) {
    Object.assign(this,{directory,convert,now,ttl,chunkBytes,maxJobs,maxReserved});
    this.jobs=new Map();this.queue=[];this.running=false;this.admission=Promise.resolve();this.journal=Promise.resolve();
  }
  async init() {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    // In-flight imports cannot survive a converter restart. Remove only our
    // temporary UUID directories; original files remain in the user's browser.
    for(const entry of await readdir(this.directory,{withFileTypes:true}))if(entry.isDirectory()&&UUID.test(entry.name))await rm(path.join(this.directory,entry.name),{recursive:true,force:true});
    this.timer=setInterval(()=>{void this.sweep().catch(()=>{});},60000);this.timer.unref?.();
  }
  async record(input={}) {
    const event={id:UUID.test(input.id||'')?input.id:randomUUID(),at:new Date(this.now()).toISOString(),stage:['upload','convert','preview','render'].includes(input.stage)?input.stage:'preview',code:CODES.has(input.code)?input.code:'server_error',format:['ppt','pptx','pdf'].includes(input.format)?input.format:'unknown',size:Number.isSafeInteger(input.size)&&input.size>=0?input.size:0,...(Number.isInteger(input.status)?{status:input.status}:{}),...(Number.isFinite(input.elapsedMs)?{elapsedMs:Math.round(input.elapsedMs)}:{})};
    for(const key of ['uploadMs','queueMs','conversionMs'])if(Number.isFinite(input[key])&&input[key]>=0)event[key]=Math.round(input[key]);
    if(event.stage==='render'){
      for(const key of ['page','pageCount'])if(Number.isInteger(input[key])&&input[key]>=1&&input[key]<=60)event[key]=input[key];
      if(['missing_browser_api','canvas_allocation','canvas_in_use','resource_unavailable','render_failed'].includes(input.reason))event.reason=input.reason;
      if(input.renderer==='legacy-5.6.205')event.renderer=input.renderer;
    }
    const file=path.join(this.directory,'diagnostics.json');
    const pending=this.journal.then(async()=>{
      let items=[];try{items=JSON.parse(await readFile(file,'utf8'));}catch{}
      await writeFile(file+'.tmp',JSON.stringify([...items.slice(-199),event]),{mode:0o600});await rename(file+'.tmp',file);
    });this.journal=pending.catch(()=>{});await pending;return {reference:event.id.slice(0,8)};
  }
  async create(owner,{size,format,requestId,chunkBytes=this.chunkBytes}={}) {
    validateMaterialSize(size);
    if(!Number.isSafeInteger(chunkBytes)||chunkBytes<this.chunkBytes||chunkBytes>MAX_UPLOAD_CHUNK_BYTES)throw fault('上传分块配置不正确。');
    if(!['ppt','pptx'].includes(format)||!UUID.test(requestId||''))throw fault('上传格式不正确。');
    const pending=this.admission.then(async()=>{
      await this.sweep();
      const prior=[...this.jobs.values()].find(j=>j.owner===owner&&j.requestId===requestId);
      if(prior){if(prior.size!==size||prior.format!==format||prior.chunkBytes!==chunkBytes)throw fault('这条上传任务与原文件不一致。',409);return this.snapshot(prior);}
      const values=[...this.jobs.values()];
      if(values.filter(j=>j.owner===owner&&!TERMINAL.has(j.state)).length>=2)throw fault('你已有材料正在导入，请等待完成后再上传。',429);
      if(values.length>=this.maxJobs||values.reduce((sum,j)=>sum+j.size+MAX_PREVIEW_BYTES,0)+size+MAX_PREVIEW_BYTES>this.maxReserved)throw fault('当前上传人数较多，请稍后再试。',429);
      const id=randomUUID(),directory=path.join(this.directory,id),job={id,owner,requestId,size,format,chunkBytes,directory,input:path.join(directory,'source.'+format),output:path.join(directory,'preview.pdf'),state:'uploading',received:0,hashes:new Map(),touched:this.now(),created:this.now(),lock:Promise.resolve()};
      await mkdir(directory,{mode:0o700});await writeFile(job.input,'',{mode:0o600});this.jobs.set(id,job);return this.snapshot(job);
    });this.admission=pending.catch(()=>{});return pending;
  }
  lookup(id,owner) {
    const job=this.jobs.get(id);
    if(!UUID.test(id)||!job||job.owner!==owner||job.cancelled)throw fault('上传任务已失效，请重新选择文件。',410,'expired');
    job.touched=this.now();return job;
  }
  snapshot(job) {return {id:job.id,state:job.state,received:job.received,size:job.size,chunkBytes:job.chunkBytes,position:job.state==='queued'?Math.max(0,this.queue.indexOf(job.id)+(this.running?1:0)):0,...(job.error?{error:job.error,code:job.code}:{}),...(job.previewSize?{previewSize:job.previewSize}:{})};}
  get(id,owner){return this.snapshot(this.lookup(id,owner));}
  async locked(job,task){const result=job.lock.then(task);job.lock=result.catch(()=>{});return result;}
  async put(id,owner,index,bytes) {
    const job=this.lookup(id,owner);
    return this.locked(job,async()=>{
      if(job.cancelled)throw fault('上传已结束，请重新选择文件。',409);
      const offset=index*job.chunkBytes,expected=Math.min(job.chunkBytes,job.size-offset);
      if(!Number.isInteger(index)||index<0||offset>=job.size||bytes.length!==expected)throw fault('文件分块大小不正确，请重新上传。');
      const hash=createHash('sha256').update(bytes).digest('hex');
      if(job.hashes.has(index)){if(job.hashes.get(index)!==hash)throw fault('重复上传的内容不一致，请重新选择文件。',409);return this.snapshot(job);}
      if(job.state!=='uploading')throw fault('上传已结束，请重新选择文件。',409);
      // Chunks may arrive out of order. Fixed offsets plus a per-index hash
      // keep retries idempotent; finish still requires every byte exactly once.
      const handle=await open(job.input,'r+');
      try {let written=0;while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw fault('临时保存材料失败，请稍后重试。',503,'storage_error');written+=result.bytesWritten;}}
      finally{await handle.close();}
      job.hashes.set(index,hash);job.received+=bytes.length;job.touched=this.now();return this.snapshot(job);
    });
  }
  async finish(id,owner) {
    const job=this.lookup(id,owner);
    return this.locked(job,async()=>{
      if(job.state!=='uploading')return this.snapshot(job);
      if(job.received!==job.size)throw fault('文件尚未上传完整，请重新选择文件。',409);
      job.uploadedAt=this.now();
      try{await validateOfficeFile(job.input,job.format);}catch(e){await this.fail(job,e);return this.snapshot(job);}
      job.state='queued';this.queue.push(id);queueMicrotask(()=>{void this.drain();});return this.snapshot(job);
    });
  }
  async receive(owner,options,bytes) {
    if(bytes.length>INLINE_UPLOAD_BYTES)throw fault('请使用分块上传。',413);
    const job=await this.create(owner,{...options,size:bytes.length});
    // Reuse exactly the same owner-bound, hashed chunks as the large-file path.
    // A timed-out HTTP retry cannot create a second conversion or change bytes.
    for(let offset=0,index=0;offset<bytes.length;offset+=job.chunkBytes,index++)await this.put(job.id,owner,index,bytes.subarray(offset,offset+job.chunkBytes));
    return this.finish(job.id,owner);
  }
  async wait(id,owner,{waitMs=PREVIEW_WAIT_MS,signal}={}) {
    const job=this.lookup(id,owner);signal?.throwIfAborted();
    if(TERMINAL.has(job.state))return this.snapshot(job);
    await new Promise((resolve,reject)=>{
      let timer;
      const clean=()=>{clearTimeout(timer);job.listeners?.delete(finish);signal?.removeEventListener('abort',abort);};
      const finish=()=>{clean();resolve();};
      const abort=()=>{clean();reject(signal.reason);};
      (job.listeners ||= new Set()).add(finish);
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(finish,Math.max(0,Math.min(PREVIEW_WAIT_MS,waitMs)));
    });
    return this.get(id,owner);
  }
  notify(job){for(const listener of [...(job.listeners||[])])listener();}
  async fail(job,e) {
    job.state='failed';job.code=CODES.has(e.code)?e.code:'conversion_failed';job.error=e.status?e.message:'PPT 处理失败，请重新另存为 PPTX 或 PDF 后重试。';job.touched=this.now();
    await this.record({id:job.id,stage:'convert',code:job.code,format:job.format,size:job.size,...this.timings(job)}).catch(()=>{});
    await rm(job.input,{force:true}).catch(()=>{});await rm(job.output,{force:true}).catch(()=>{});
    this.notify(job);
  }
  timings(job) {
    return {elapsedMs:this.now()-job.created,
      ...(job.uploadedAt!==undefined?{uploadMs:job.uploadedAt-job.created}:{}),
      ...(job.conversionStartedAt!==undefined?{queueMs:job.conversionStartedAt-job.uploadedAt,conversionMs:this.now()-job.conversionStartedAt}:{})};
  }
  async drain() {
    if(this.running)return;this.running=true;
    try{while(this.queue.length){const job=this.jobs.get(this.queue.shift());if(!job||job.cancelled)continue;job.state='converting';job.conversionStartedAt=this.now();
      try{await this.convert(job.input,job.format,job.output);const info=await stat(job.output);if(!info.size||info.size>MAX_PREVIEW_BYTES)throw fault('预览文件过大或不完整，请导出为 PDF 后重试。',422,'preview_too_large');job.previewSize=info.size;await rm(job.input,{force:true});await this.record({id:job.id,stage:'convert',code:'complete',format:job.format,size:job.size,...this.timings(job)}).catch(()=>{});job.state='complete';job.touched=this.now();this.notify(job);}
      catch(e){await this.fail(job,e);}
      finally{if(job.cancelled)await this.remove(job);}
    }}finally{this.running=false;}
  }
  preview(id,owner){const job=this.lookup(id,owner);if(job.state!=='complete')throw fault('页面预览尚未准备好。',409);return {file:job.output,size:job.previewSize};}
  async notes(id,owner){
    const job=this.lookup(id,owner);
    if(job.state!=='complete')throw fault('材料尚未准备好。',409);
    if(job.format!=='ppt')return {notes:[],status:'complete'};
    try{return JSON.parse(await readFile(job.output+'.notes.json','utf8'));}
    catch{return {notes:[],status:'unavailable'};}
  }
  async remove(job){await job.lock;this.jobs.delete(job.id);this.queue=this.queue.filter(id=>id!==job.id);await rm(job.directory,{recursive:true,force:true});}
  async cancel(id,owner){const job=this.lookup(id,owner);job.cancelled=true;this.notify(job);if(job.state!=='converting')await this.remove(job);return {ok:true};}
  async cancelRequest(requestId,owner){await this.admission;const job=[...this.jobs.values()].find(j=>j.owner===owner&&j.requestId===requestId&&!j.cancelled);if(job)await this.cancel(job.id,owner);return {ok:true};}
  async sweep(){for(const job of this.jobs.values())if(job.state!=='converting'&&this.now()-job.touched>this.ttl){job.cancelled=true;await this.remove(job);}}
  close(){clearInterval(this.timer);}
}
