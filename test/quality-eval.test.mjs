import test from 'node:test';
import assert from 'node:assert/strict';
import {characterErrors,scoreAsrWindows,screenCase} from '../scripts/eval-metrics.mjs';
import {neutralConflict,alignAdviceWithIssues} from '../lib/evidence-review.mjs';
import {numericFacts} from '../public/numeric-facts.mjs';
import {validateRevisionResult} from '../public/revision-core.mjs';
test('CER忽略标点空格，不忽略数字、否定或插入；可超过100%',()=>{
 assert.equal(characterErrors('S-O-R 理论。','s o r理论').cer,0);
 assert.equal(characterErrors('8人','80人').edits,1);
 assert.equal(characterErrors('没有影响','有影响').edits,1);
 assert.equal(characterErrors('好','非常非常好').cer,4);
 assert.equal(characterErrors('','你好').cer,null);
});
test('未经回听确认的参考文字绝不计入识别准确率',()=>{
 const result=scoreAsrWindows([{id:'a',start:0,end:2,status:'pending',reference:'从PPT猜的真值'}],{before:[{start:0,end:2,text:'从PPT猜的真值'}]});
 assert.equal(result.scores.before.cer,null);assert.equal(result.reviewedWindows,0);
});
test('不同ASR分句按同一确认时间窗口比较，汇总按字符加权',()=>{
 const windows=[{id:'a',start:0,end:3,status:'confirmed',reference:'SOR理论'},{id:'b',start:4,end:5,status:'confirmed',reference:'好'}];
 const r=scoreAsrWindows(windows,{before:[{start:0,end:3,text:'SOR理论'},{start:4,end:5,text:'不'}],after:[{start:0,end:1,text:'S.'},{start:1,end:2,text:'O.'},{start:2,end:3,text:'R.理论'},{start:4,end:5,text:'好'}]});
 assert.equal(r.scores.before.cer,1/6);assert.equal(r.scores.after.cer,0);
});
test('评估不把内部删除理由中的口误字样当作用户可见建议',()=>{
 const c={kind:'diagnosis',expected:'no_issue',session:{segments:[]},rubric:[]};
 assert.equal(screenCase(c,{issues:[],summary:'可以保留',nextStep:'继续练习',evidenceAudit:[{rationale:'不能证明口误'}]}).screenPassed,true);
 assert.equal(screenCase(c,{issues:[],summary:'出现口误',nextStep:'照念'}).screenPassed,false);
});
const session={pages:[{number:1,text:'单向假设：信任影响意愿。'}],segments:[{id:'s1',page:1,text:'本次的单向假设是意愿影响信任。'}]};
const issue={segmentId:'s1',quote:'意愿影响信任',title:'方向说反了',why:'你讲错了',suggestion:'应改回信任影响意愿',action:'revise'};
const decision={evidence:[{source:'slide',page:1,quote:'信任影响意愿'},{source:'speech',segmentId:'s1',quote:'意愿影响信任'}]};
test('事实冲突保留成对原文，所有建议字段中立且不自动改回PPT',()=>{
 const result=neutralConflict(issue,decision,session);
 assert.equal(result.action,'clarify');assert.equal(result.conflictEvidence.length,2);
 assert.match(result.why,/信任影响意愿/);assert.match(result.why,/意愿影响信任/);
 assert.doesNotMatch(JSON.stringify(result),/说反|讲错|改回/);
 const report=alignAdviceWithIssues({summary:'说反了',issues:[result],nextStep:'改回去'},{neutralized:true});assert.doesNotMatch(JSON.stringify(report),/说反|改回/);
});
test('冲突复核拒绝不存在的材料引用或另一无关发言',()=>{
 assert.throws(()=>neutralConflict(issue,{evidence:[{source:'slide',page:1,quote:'未出现的内容'},decision.evidence[1]]},session),/未在/);
 assert.throws(()=>neutralConflict(issue,{evidence:[decision.evidence[0],decision.evidence[0]]},session),/关联/);
 assert.throws(()=>neutralConflict(issue,{evidence:[decision.evidence[0]]},session),/两处/);
});
test('两条发言之间的冲突不会伪装成材料内容',()=>{
 const s={pages:[],segments:[{id:'s1',page:1,text:'已经访谈5人'},{id:'s2',page:2,text:'已经访谈30人'}]};
 const r=neutralConflict({segmentId:'s2',quote:'已经访谈30人'},{evidence:[{source:'speech',segmentId:'s1',quote:'已经访谈5人'},{source:'speech',segmentId:'s2',quote:'已经访谈30人'}]},s);
 assert.match(r.why,/第1页发言/);assert.doesNotMatch(r.why,/材料/);
});
test('没有问题时下一步不夹带新修改要求',()=>{
 const r=alignAdviceWithIssues({summary:'没问题',issues:[],nextStep:'补充研究对象与数据'});
 assert.match(r.nextStep,/保留/);assert.doesNotMatch(r.nextStep,/补充/);
});
test('中文人数和百分比与阿拉伯数字一致，普通措辞不误当人数',()=>{
 assert.deepEqual(numericFacts('三十位同学，两人，百分之八十，八成'),['80%','30','2','80%']);
 assert.deepEqual(numericFacts('一方面有想法，另一方面仍不确定'),[]);
});
test('中文新增人数不能绕过改稿事实保护，已确认数字可以换写法',()=>{
 const request={session:{segments:[{id:'s1',text:'尚未开展访谈。'}]},issue:{segmentId:'s1'},answers:[]};
 assert.equal(validateRevisionResult({status:'draft',revisedText:'已经访谈三十位同学。',reason:'更具体'},request).status,'needs_input');
 request.answers=[{answer:'已访谈30位同学。'}];
 assert.equal(validateRevisionResult({status:'draft',revisedText:'已经访谈三十位同学。',reason:'换成口语'},request).status,'draft');
});
