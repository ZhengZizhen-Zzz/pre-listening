import {openingQuestion} from './opening-question.mjs';
import {retryRead} from './retry-read.mjs';
import {validateQuestion, questionCountFor} from './training-core.mjs';

// Session-scoped snapshots: no stale question after edits and no paid regeneration on refresh.
export class QuestionPrefetch {
  constructor({api,storage,onChange=()=>{},now=Date.now,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
    Object.assign(this,{api,storage,onChange,now,pause});this.entries=new Map();
  }
  key(session){return JSON.stringify(session);}
  peek(session){return this.entries.get(this.key(session));}
  seed(session,questions,result={}){
    const key=this.key(session);if(this.entries.get(key)?.pending)return false;
    try{
      const checked=questions.map(q=>validateQuestion(q,session));
      if(checked.length<3||checked.length>10||checked.some(q=>!q.rubric))return false;
      this.entries.set(key,{session,count:checked.length,status:'complete',questions:checked,result:{...result,questions:checked}});return true;
    }catch{return false;}
  }
  async prepare(session){
    const key=this.key(session),existing=this.entries.get(key);if(existing)return existing.pending||existing;
    const entry={session,count:questionCountFor(session),status:'loading',questions:[openingQuestion(session)].filter(Boolean)};this.entries.set(key,entry);this.onChange(entry);
    while(this.entries.size>4)this.entries.delete(this.entries.keys().next().value);
    entry.pending=this.work(key,entry);return entry.pending;
  }
  async work(key,entry){
    let storeKey;
    try{
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key));
      storeKey='question-prefetch-v2:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      const saved=await this.storage.getMeta(storeKey);
      if(saved&&saved.expires>this.now())Object.assign(entry,saved);
      // A failed automatic attempt is not silently submitted again on refresh.
      if(entry.status==='failed')return entry;
      if(entry.status==='complete'){entry.questions=entry.questions.map(q=>validateQuestion(q,entry.session));this.onChange(entry);return entry;}
      let job=entry.id?await retryRead(()=>this.api('/api/training/question-jobs/'+encodeURIComponent(entry.id),{signal:AbortSignal.timeout(15000)})):await this.api('/api/training/question-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:entry.session,count:entry.count,background:true,...(entry.questions.length?{seedQuestions:entry.questions}:{})}),signal:AbortSignal.timeout(15000)});
      const began=this.now();
      for(;;){
        const questions=job.questions.length?job.questions.map(q=>validateQuestion(q,entry.session)):entry.questions;
        Object.assign(entry,{id:job.id,status:job.status,questions,result:job.result||null});
        await this.storage.setMeta(storeKey,{id:entry.id,status:entry.status,count:entry.count,questions,result:entry.result,expires:this.now()+24*60*60*1000});
        this.onChange(entry);
        if(['complete','failed'].includes(job.status))return entry;
        if(this.now()-began>240000)return entry;
        await this.pause(1500);job=await retryRead(()=>this.api('/api/training/question-jobs/'+encodeURIComponent(job.id),{signal:AbortSignal.timeout(15000)}));
      }
    }catch{
      entry.status='failed';
      if(storeKey)await this.storage.setMeta(storeKey,{status:'failed',count:entry.count,expires:this.now()+24*60*60*1000}).catch(()=>{});
      this.onChange(entry);return entry;
    }finally{delete entry.pending;}
  }
}
