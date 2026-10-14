import test from 'node:test';
import assert from 'node:assert/strict';
import { groupTranscript, editPageTranscript, compileScriptPages, transcriptSource } from '../public/transcript-core.mjs';
import { extractSpeechTerms, cleanSpeechTerms } from '../public/speech-terms.mjs';
import { pageDurations, validateSession } from '../public/core.mjs';
import { analysisKey } from '../lib/analysis-cache.mjs';

const pages=[{number:1,text:'封面'},{number:2,text:'方案'},{number:3,text:'结论'}];
const segments=[{id:'s1',page:1,start:1,end:4,text:'开场。',source:'asr'},{id:'s2',page:2,start:5,end:8,text:'方案甲。',source:'asr'},{id:'s3',page:2,start:9,end:12,text:'方案乙。',source:'asr'},{id:'s4',page:1,start:13,end:15,text:'回到开场。',source:'asr'}];
test('一句或多句都按页显示，回翻合并但不修改原句与时间戳',()=>{
  const before=structuredClone(segments), grouped=groupTranscript(segments,pages);
  assert.equal(grouped.length,3);assert.equal(grouped[1].text,'方案甲。\n方案乙。');
  assert.equal(grouped[0].parts.length,2);assert.equal(grouped[2].text,'');
  assert.deepEqual(segments,before);
});
test('整页编辑保持其他页面与原数据，取消已无法精确定位的句子时间戳',()=>{
  const changed=editPageTranscript(segments,2,'更正后的方案。');
  assert.equal(changed.filter(s=>s.page===2).length,1);assert.equal(changed.find(s=>s.page===2).start,null);
  assert.equal(changed.find(s=>s.page===2).source,'edited');
  assert.deepEqual(changed.filter(s=>s.page===1),segments.filter(s=>s.page===1));assert.equal(segments.length,4);
  assert.equal(new Set(changed.map(s=>s.id)).size,changed.length);
  assert.equal(editPageTranscript(segments,2,'方案甲。\n方案乙。'),segments);
});
test('未采用修改也可生成按页讲稿；采用只替换对应段落',()=>{
  const original=compileScriptPages(segments,pages);assert.equal(original.length,2);assert.equal(original[1].changed,false);
  const revised=compileScriptPages(segments,pages,{s2:{text:'调整后的方案甲。'}});
  assert.equal(revised[1].text,'调整后的方案甲。\n方案乙。');assert.equal(revised[1].changed,true);assert.equal(segments[1].text,'方案甲。');
});
test('来源标识进入验证和缓存，避免把自动识别当成已核实文字',()=>{
  assert.equal(transcriptSource(segments,true),'asr');
  assert.equal(transcriptSource([{text:'手录',start:null}],false),'manual');
  const session=validateSession({pages,segments,transcriptSource:'asr'});
  assert.equal(session.transcriptSource,'asr');assert.equal(session.segments[0].source,'asr');
  assert.notEqual(analysisKey(session,{},'v1'),analysisKey({...session,transcriptSource:'manual'},{},'v1'));
});
test('每页用时累计回翻与停顿，手动文本不冒充计时',()=>{
  const result=pageDurations([{page:3,at:0},{page:1,at:.65},{page:2,at:14.08},{page:3,at:74.11}],146.33,3);
  assert.ok(Math.abs(result.reduce((a,b)=>a+b,0)-146.33)<1e-8);
  assert.deepEqual(pageDurations([],null,3),[0,0,0]);assert.ok(Math.abs(result[0]-13.43)<.01);
});
test('PPT提示提取姓名与术语，限制数量和长度，不把数字作为热词纠正',()=>{
  const terms=extractSpeechTerms([{text:'研究生导师：赖坤老师\n娱乐趣味性、互动性\n信息实用性、易用性\nS-O-R\n已访谈30人'}]);
  for(const term of ['赖坤','娱乐趣味性','信息实用性','易用性'])assert.ok(terms.includes(term),term);
  assert.ok(!terms.includes('已访谈30人'));assert.deepEqual(cleanSpeechTerms(['术语','术语','123',null,'这是一个远远超过十五个字符限制的长句子']),['术语']);
});
