import {mkdir,readFile,writeFile,rename,readdir,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {normalizeFeedback,FEEDBACK_MAX_BYTES} from '../public/feedback-core.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export class FeedbackStore {
  constructor(directory,{now=()=>new Date().toISOString(),maxEntries=500}={}) {Object.assign(this,{directory,now,maxEntries});this.writes=Promise.resolve();}
  async submit(owner,input) {
    if(Buffer.byteLength(JSON.stringify(input))>FEEDBACK_MAX_BYTES)throw Object.assign(new Error('反馈较大，请取消附带练习记录后重试。'),{status:413});
    const content=normalizeFeedback(input),id=hash(`${owner}:${content.clientId}`),participant=hash(owner).slice(0,16),fingerprint=hash(JSON.stringify(content));
    const write=this.writes.catch(()=>{}).then(async()=>{
      await mkdir(this.directory,{recursive:true,mode:0o700});
      let previous;try{previous=await this.get(id);}catch(e){if(e.status!==404)throw e;}
      if(previous?.fingerprint===fingerprint)return {id,submittedAt:previous.updatedAt,unchanged:true};
      if(!previous){
        const names=(await readdir(this.directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));
        if(names.length>=this.maxEntries)throw Object.assign(new Error('反馈箱已满，请联系邀请你的朋友。'),{status:429});
        let owned=0;for(const name of names){const saved=await this.get(name.slice(0,-5));if(saved.participant===participant)owned++;}
        if(owned>=40)throw Object.assign(new Error('本轮提交较多，请联系邀请你的朋友。'),{status:429});
      }
      const now=this.now(),data={id,participant,createdAt:previous?.createdAt||now,updatedAt:now,revision:(previous?.revision||0)+1,fingerprint,...content};
      const file=path.join(this.directory,`${id}.json`),temporary=`${file}.${randomUUID()}.tmp`;
      try{await writeFile(temporary,JSON.stringify(data),{mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
      return {id,submittedAt:now,unchanged:false};
    });
    this.writes=write;return write;
  }
  async get(id) {
    if(!/^[a-f0-9]{64}$/.test(id))throw Object.assign(new Error('未找到这条反馈。'),{status:404});
    try{return JSON.parse(await readFile(path.join(this.directory,`${id}.json`),'utf8'));}
    catch(e){if(e.code==='ENOENT')throw Object.assign(new Error('未找到这条反馈。'),{status:404});throw e;}
  }
  async list() {
    let names;try{names=await readdir(this.directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const rows=[];
    for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){
      const s=await this.get(name.slice(0,-5)),issues=s.record?.report?.issues||[];
      rows.push({id:s.id,participant:s.participant,nickname:s.nickname,helpful:s.helpful,comment:s.comment,title:s.record?.title||'使用感受',
        createdAt:s.createdAt,updatedAt:s.updatedAt,revision:s.revision,issueCount:issues.length,
        judged:issues.filter(i=>i.feedback.judgment).length,correct:issues.filter(i=>i.feedback.judgment==='correct').length,
        willing:issues.filter(i=>i.feedback.adoption==='yes').length,adoptionAnswered:issues.filter(i=>i.feedback.adoption).length,
        trainingCount:s.training.length});
    }
    return rows.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
}
