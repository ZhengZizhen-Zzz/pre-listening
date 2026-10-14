import {randomUUID, createHash} from 'node:crypto';

const fault=(message,status)=>Object.assign(new Error(message),{status});
// Short, owner-scoped polling requests survive a slow model or tunnel timeout.
export class QuestionJobs {
  constructor({produce,now=Date.now,ttlMs=2*60*60*1000,maxEntries=32}) {
    Object.assign(this,{produce,now,ttlMs,maxEntries});this.jobs=new Map();
  }
  prune(){for(const[id,j]of this.jobs)if(j.expires<=this.now()&&!['pending','reviewing'].includes(j.status))this.jobs.delete(id);}
  public(j){return structuredClone({id:j.id,status:j.status,questions:j.result?.questions||j.prepared?.questions||[],result:j.result||null,error:j.error||'',retryable:j.status==='failed',elapsedMs:this.now()-j.startedAt,firstReadyMs:j.firstReadyMs??null});}
  get(id,owner){this.prune();const j=this.jobs.get(id);if(!j||j.owner!==owner)throw fault('提问任务已过期或服务已重启，请重新生成；已填写的回答仍保留。',404);return this.public(j);}
  async first(id,owner,timeoutMs=6000){
    const current=this.get(id,owner);if(current.status!=='pending')return current;
    const j=this.jobs.get(id);
    await new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);j.listeners?.delete(done);resolve();};
      const timer=setTimeout(done,timeoutMs);(j.listeners??=new Set()).add(done);
    });
    return this.get(id,owner);
  }
  notify(j){for(const done of j.listeners||[])done();}
  create(request,owner,{retry=false,prepared,background=false}={}){
    this.prune();const key=createHash('sha256').update(JSON.stringify({owner,request})).digest('hex');
    const existing=[...this.jobs.values()].find(j=>j.key===key);
    if(existing){
      if(retry&&existing.status==='failed'){existing.retries++;existing.error='';existing.background=background;existing.status=existing.prepared?'reviewing':'pending';existing.pending=this.execute(existing);}
      return this.public(existing);
    }
    // Completed results live in each browser too. Evict only terminal jobs;
    // never discard another visitor's in-flight preparation.
    if(this.jobs.size>=this.maxEntries){
      const terminal=[...this.jobs.values()].filter(j=>['complete','failed'].includes(j.status)).sort((a,b)=>a.startedAt-b.startedAt);
      for(const j of terminal){if(this.jobs.size<this.maxEntries)break;this.jobs.delete(j.id);}
    }
    if(this.jobs.size>=this.maxEntries)throw fault('当前问题准备较多，请稍后再试。',429);
    if([...this.jobs.values()].some(j=>j.owner===owner&&['pending','reviewing'].includes(j.status)))throw fault('问题仍在准备中，请稍后继续。',409);
    const j={id:randomUUID(),key,owner,request,prepared,background,status:prepared?'reviewing':'pending',retries:0,startedAt:this.now(),expires:this.now()+this.ttlMs};
    this.jobs.set(j.id,j);j.pending=this.execute(j);return this.public(j);
  }
  async execute(j){
    try {
      const result=await this.produce(j.request,ready=>{
        j.prepared=structuredClone(ready);j.status='reviewing';j.firstReadyMs??=this.now()-j.startedAt;
        this.notify(j);
      },j.prepared,j.owner,{background:j.background});
      j.result=result;j.status='complete';j.expires=this.now()+this.ttlMs;
      this.notify(j);
      console.info(`Question job complete: first=${j.firstReadyMs??this.now()-j.startedAt}ms total=${this.now()-j.startedAt}ms count=${result.questions.length}`);
    } catch(e){j.status='failed';j.error=e.status?e.message:'提问暂未准备完成，请重试；已有内容已保留。';j.expires=this.now()+this.ttlMs;this.notify(j);}
  }
}
