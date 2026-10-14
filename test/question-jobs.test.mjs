import test from 'node:test';import assert from 'node:assert/strict';
import {QuestionJobs} from '../lib/question-jobs.mjs';
const settle=()=>new Promise(r=>setImmediate(r));
test('暂存满后回收已完成任务，新的朋友可以继续生成，仍在生成的任务保留',async()=>{
 let finish;const jobs=new QuestionJobs({maxEntries:2,produce:async request=>request.wait?new Promise(r=>finish=r):{questions:[{question:request.name}]}});
 const active=jobs.create({wait:true},'a');const old=jobs.create({name:'old'},'b');await settle();
 const next=jobs.create({name:'new'},'c');await settle();assert.equal(jobs.get(next.id,'c').status,'complete');assert.equal(jobs.get(active.id,'a').status,'pending');assert.throws(()=>jobs.get(old.id,'b'),{status:404});
 finish({questions:[{question:'done'}]});await settle();assert.equal(jobs.get(active.id,'a').status,'complete');assert.throws(()=>jobs.get(active.id,'c'),{status:404});
});
test('暂存全部在处理中时拒绝新增，不删掉正在准备的问题；同一任务复用不计费',async()=>{
 const jobs=new QuestionJobs({maxEntries:2,produce:()=>new Promise(()=>{})});const a=jobs.create({name:'a'},'a');jobs.create({name:'b'},'b');assert.throws(()=>jobs.create({name:'c'},'c'),{status:429});assert.equal(jobs.create({name:'a'},'a').id,a.id);assert.equal(jobs.jobs.size,2);
});
