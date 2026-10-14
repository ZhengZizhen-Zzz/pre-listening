import test from 'node:test';
import assert from 'node:assert/strict';
import {compareRounds,nextRoundBaseline,speechMetrics,speechUnits} from '../public/comparison-core.mjs';
const first=()=>({id:'a',roundId:'a',audioAssetId:'audio-a',pdfAssetId:'deck',pages:[{number:1,text:'问题'},{number:2,text:'方案'}],segments:[{id:'s1',page:1,text:'计划访谈三个人',source:'asr',start:0,end:20}],events:[{page:1,at:0},{page:2,at:40}],durationSeconds:100,recordingStatus:'complete',goals:{audience:'同学',takeaways:'方案',targetMinutes:5}});
const second=()=>({...first(),id:'b',roundId:'b',previousRoundId:'a',audioAssetId:'audio-b',durationSeconds:80,events:[{page:1,at:0},{page:2,at:20}]});
test('真实两轮按独立翻页记录比较时长，缩短不输出改善结论',()=>{const result=compareRounds(first(),second());assert.equal(result.available,true);assert.equal(result.totalDelta,-20);assert.deepEqual(result.pages.map(p=>[p.beforeSeconds,p.afterSeconds]),[[40,20],[60,60]]);assert.equal(result.improved,undefined);});
test('同音频、同轮次修订、不同材料、示例与无关联记录不能算两轮',()=>{
  for(const override of [{audioAssetId:'audio-a'},{roundId:'a'},{pdfAssetId:'another'},{pages:[{number:1,text:'别的内容'}]},{demo:true},{previousRoundId:null}]) assert.equal(compareRounds(first(),{...second(),...override}).available,false);
});
test('中断、未完成、旧版与乱序时间轴不作完整时长对比',()=>{
  for(const override of [{recordingStatus:'interrupted'},{recordingStatus:'recording'},{recordingStatus:null},{events:[{page:1,at:0},{page:2,at:90},{page:1,at:10}]}]) assert.equal(compareRounds(first(),{...second(),...override}).timingAvailable,false);
});
test('空白下一轮草稿继续关联原轮次，文字修订保留自己作为可核对的版本',()=>{assert.equal(nextRoundBaseline({id:'draft',previousRoundId:'a',segments:[],durationSeconds:null}),'a');assert.equal(nextRoundBaseline(first()),'a');});
test('语速仅使用原始ASR及完整时长，修订和手工字数不伪装精确指标',()=>{
  assert.equal(speechUnits('AI汇报 2026 Hello 世界'),7);
  assert.equal(speechMetrics({...first(),durationSeconds:60}).estimatedRate,7);
  assert.equal(speechMetrics({...first(),recordingStatus:'interrupted'}).estimatedRate,null);
  assert.equal(speechMetrics({...first(),segments:[{text:'很多字',source:'edited',start:null,end:null}]}).estimatedRate,null);
  assert.equal(speechMetrics({...first(),segments:[{text:'添加了很多文字',source:'edited'}],originalSegments:first().segments,durationSeconds:60}).estimatedRate,7);
});
test('用户否定的建议不当成复练目标；原句不出现不等于解决',()=>{
  const before={...first(),report:{issues:[{title:'A',page:1,quote:'计划访谈三个人'},{title:'B',page:2,quote:'不存在'}]},feedback:{0:{judgment:'incorrect'}}};
  const result=compareRounds(before,second());assert.equal(result.issues.length,1);assert.equal(result.issues[0].confirmed,false);assert.equal(result.issues[0].quoteRepeated,false);assert.equal(result.issues[0].improved,undefined);
});
test('目标字段顺序不影响比较，但改变听众有提示',()=>{assert.equal(compareRounds(first(),{...second(),goals:{targetMinutes:'5',takeaways:'方案',audience:'同学'}}).goalsChanged,false);assert.equal(compareRounds(first(),{...second(),goals:{...first().goals,audience:'评委'}}).goalsChanged,true);});
