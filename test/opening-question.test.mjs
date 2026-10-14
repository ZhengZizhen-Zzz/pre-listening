import test from 'node:test';import assert from 'node:assert/strict';
import {openingQuestion} from '../public/opening-question.mjs';
import {QuestionPrefetch} from '../public/question-prefetch.mjs';
const session={audience:'老师和同学',targetMinutes:5,takeaways:'',pages:[{number:1,text:'课题介绍'},{number:2,text:'研究方法：访谈使用者，了解预约座位遇到的障碍。'}],segments:[{id:'s1',page:2,text:'我们计划用访谈了解同学为什么放弃预约座位。',start:0,end:4}]};
test('即时开场题有连续原文依据，不把研究计划改写为已有结论',()=>{const q=openingQuestion(session);assert.ok(q);assert.ok(session.segments[0].text.includes(q.evidence.quote));assert.match(q.question,/计划/);assert.equal(q.rubric.criteria.length,2);assert.equal(q.page,2);});
test('只有封面寒暄或没有文字时不编造问题',()=>{assert.equal(openingQuestion({pages:[{number:1,text:'谢谢大家\n汇报人：张同学'}],segments:[]}),null);assert.equal(openingQuestion({pages:[],segments:[]}),null);});
test('未发网络请求就已有第一题；模型失败保留首题，提交一次并把首题作为种子',async()=>{
 let release,body,calls=0;const store=new Map();const prefetch=new QuestionPrefetch({storage:{getMeta:async k=>store.get(k),setMeta:async(k,v)=>store.set(k,v)},api:async(url,opts)=>{calls++;body=JSON.parse(opts.body);return new Promise(r=>release=r);}});
 const pending=prefetch.prepare(session);const first=prefetch.peek(session).questions[0];assert.ok(first);assert.equal(calls,0);
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);assert.deepEqual(body.seedQuestions,[first]);release({id:'test',status:'failed',questions:[],error:'network'});await pending;assert.deepEqual(prefetch.peek(session).questions,[first]);await prefetch.prepare(session);assert.equal(calls,1);
});
test('模型补题保留原题，重载恢复已有题目不重新计费',async()=>{
 const first=openingQuestion(session),store=new Map();const questions=[first,...['你如何设计访谈？','这项研究下一步准备做什么？'].map(question=>({...first,question}))];let calls=0;
 const storage={getMeta:async k=>store.get(k),setMeta:async(k,v)=>store.set(k,v)};
 const api=async()=>{calls++;return {id:'test',status:'complete',questions,result:{questions}};};
 const prefetch=new QuestionPrefetch({storage,api});const result=await prefetch.prepare(session);assert.deepEqual(result.questions[0],first);const reopened=new QuestionPrefetch({storage,api});await reopened.prepare(session);assert.equal(calls,1);assert.equal(reopened.peek(session).questions.length,3);
});
