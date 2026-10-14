import test from 'node:test';
import assert from 'node:assert/strict';
import { alignSegments, pageDurations, validateReport, validateSession, conciseIssueTitle, materialCoverage } from '../public/core.mjs';
import { buildDiagnosisInput } from '../lib/providers.mjs';
const session = () => ({pages:[{text:'问题与背景'},{text:'验证方案'}],segments:[{id:'s1',page:1,start:0,end:6,text:'我们目前还没有真实数据，需要进一步访谈。'}],events:[{page:1,at:0},{page:2,at:5}],durationSeconds:10,targetSeconds:300});
test('60页导入与分析保留最后一页的文字、发言、时间线和建议定位，61页拒绝',()=>{
  const input=session();input.pages=Array.from({length:60},(_,i)=>({text:`材料第${i+1}页`}));input.segments[0].page=60;input.events=[{page:60,at:0}];
  const clean=validateSession(input),payload=buildDiagnosisInput(clean);
  assert.equal(payload.slideMaterial.length,60);assert.equal(payload.slideMaterial[59].text,'材料第60页');assert.equal(payload.actualSpeech[0].page,60);assert.equal(clean.events[0].page,60);
  const report=validateReport({summary:'测试',issues:[{title:'需要确认',segmentId:'s1',quote:'没有真实数据',why:'待验证',suggestion:'先访谈'}]},clean);
  assert.equal(report.issues[0].page,60);input.pages.push({text:'多出的一页'});assert.throws(()=>validateSession(input),e=>e.code==='page_limit' && /61 页/.test(e.message));
});
test('跨页句子按中点映射，并标记供用户纠正', () => { const aligned = alignSegments([{start:4,end:8,text:'跨页'}],session().events); assert.equal(aligned[0].page,2); assert.equal(aligned[0].crossesPage,true); });
test('回翻和重复停留累计到同一页面', () => { assert.deepEqual(pageDurations([{page:1,at:0},{page:2,at:3},{page:1,at:7}],10,2),[6,4]); });
test('手动发言没有虚构时间戳', () => { const s=session(); s.segments[0].start=null;s.segments[0].end=null;s.durationSeconds=null;s.events=[];const clean=validateSession(s);assert.equal(clean.segments[0].start,null); });
test('拒绝无效页码、逆序时间线及负时长', () => {const a=session();a.segments[0].page=8;assert.throws(()=>validateSession(a));const b=session();b.events=[{page:1,at:5},{page:2,at:1}];assert.throws(()=>validateSession(b));const c=session();c.durationSeconds=-1;assert.throws(()=>validateSession(c));});
test('拒绝重复发言编号与没有任何页面的请求', () => {const a=session();a.segments.push({...a.segments[0]});assert.throws(()=>validateSession(a));const b=session();b.pages=[];assert.throws(()=>validateSession(b));});
test('图片型材料仍可分析真实发言，报告明确无法核对幻灯片', () => {
  const s=session();s.pages.forEach(p=>p.text='');
  const clean=validateSession(s);
  const report=validateReport({summary:'发言可以继续评估',issues:[]},clean);
  assert.equal(clean.segments.length,1);assert.equal(report.materialCoverage.mode,'speech_only');
  assert.deepEqual(report.materialCoverage.missingPages,[1,2]);assert.match(report.limits[0],/仅分析发言和用时/);
  s.segments=[];assert.throws(()=>validateSession(s),/真实发言/);
});
test('部分页面未读到文字时保留准确页码，不把它解释为内容空白', () => {
  const result=materialCoverage([{text:'已读到的材料'},{text:' '},{text:'最后一页'}]);
  assert.equal(result.mode,'partial');assert.deepEqual(result.missingPages,[2]);
});
test('模型不能伪造证据或指定错误页面和回听时间', () => {const raw={summary:'需要确认',issues:[{title:'证据不足',segmentId:'s1',page:99,start:900,quote:'没有真实数据',why:'待验证',suggestion:'先确认',action:'clarify'}]};const report=validateReport(raw,session());assert.equal(report.issues[0].page,1);assert.equal(report.issues[0].start,0);const bad=structuredClone(raw);bad.issues[0].quote='用户增长了50%';assert.throws(()=>validateReport(bad,session()));});
test('可核对和不可核对的建议分开处理', () => {const good={title:'需要确认',segmentId:'s1',quote:'没有真实数据',why:'待验证',suggestion:'先访谈'};const report=validateReport({summary:'原总结',issues:[good,{...good,quote:'完全不存在的说法'}]},session());assert.equal(report.issues.length,1);assert.equal(report.rejected,1);assert.match(report.summary,/未通过核对/);});
test('移除标题中的重复定位，保留问题本身和正文里的跨页比较', () => {
  assert.equal(conciseIssueTitle('第一页 封面信息：开场缺少核心结论'), '开场缺少核心结论');
  assert.equal(conciseIssueTitle('第 1 页：开场缺少核心结论'), '开场缺少核心结论');
  assert.equal(conciseIssueTitle('封面信息：开场缺少核心结论'), '开场缺少核心结论');
  assert.equal(conciseIssueTitle('人数与第 2 页不同'), '人数与第 2 页不同');
  assert.equal(conciseIssueTitle('第1页与第2页人数矛盾'), '第1页与第2页人数矛盾');
});
test('结构化复盘兼容旧报告，过滤错误证据时不保留关联总结', () => {
  const old = validateReport({ summary: '旧总结', issues: [] }, session());
  assert.deepEqual(old.strengths, []); assert.ok(old.nextStep);
  const good = { title: '需要确认', segmentId: 's1', quote: '没有真实数据', why: '待验证', suggestion: '先访谈' };
  const mixed = validateReport({ summary: '存在错误内容', strengths: ['不存在的优点'], nextStep: '错误动作', issues: [good, { ...good, quote: '不存在的原文' }] }, session());
  assert.deepEqual(mixed.strengths, []); assert.equal(mixed.nextStep, '先访谈');
});
