import test from 'node:test';
import assert from 'node:assert/strict';
import {presenterNotes,presenterTiming} from '../public/presenter-core.mjs';
test('讲稿显示已采用的修改，未录入的页面用上一轮参考，不把 PPT 文字当讲稿',()=>{
  const state={pages:[{number:1,text:'slide text'},{number:2},{number:3}],segments:[{id:'s1',page:1,text:'原话'}],scripts:{s1:{text:'采用后的讲稿'}},referenceScript:[{page:1,text:'旧稿'},{page:2,text:'第二页参考'}]};
  assert.equal(presenterNotes(state,1),'采用后的讲稿');assert.equal(presenterNotes(state,2),'第二页参考');assert.equal(presenterNotes(state,3),'');
  assert.equal(presenterNotes({...state,segments:[],referenceScript:[]},1),'');
});
test('续录累计时长、往返翻页用时与超时一致，停止后计时冻结',()=>{
  const state={recording:true,recordingOffset:50,started:1000,pages:[{},{}],current:1,events:[{page:1,at:0},{page:2,at:20},{page:1,at:50}]};
  assert.deepEqual(presenterTiming(state,60,16000),{elapsed:65,pageSeconds:35,remaining:0,over:5});
  assert.deepEqual(presenterTiming({...state,recording:false,duration:65},90,90000),{elapsed:65,pageSeconds:35,remaining:25,over:0});
});
test('PPT notes precede raw speech, adopted drafts are separate and original remains selectable',async()=>{
 const {presenterNoteSources}=await import('../public/presenter-core.mjs');
 const state={pages:[{number:1}],segments:[{id:'s1',page:1,text:'实际发言'}],originalNotes:[{page:1,text:'原备注\n第二段'}]};
 assert.equal(presenterNotes(state,1),'原备注\n第二段');
 const updated={...state,scripts:{s1:{text:'修改稿'}}};
 assert.equal(presenterNotes(updated,1),'修改稿');
 assert.deepEqual(presenterNoteSources(updated,1).map(s=>[s.id,s.text]),[['practice','修改稿'],['original','原备注\n第二段']]);
 assert.equal(state.originalNotes[0].text,'原备注\n第二段');
 assert.equal(presenterNotes({...state,segments:[],referenceScript:[{page:1,text:'上一轮修改稿'}]},1),'上一轮修改稿');
});
test('imported script and original are presenter-only, without being added to actual speech',()=>{
 const state={pages:[{number:1,text:'PPT'}],segments:[],importedScript:{originalText:'原稿不可覆盖',parts:[{page:1,text:'供演练的稿子',link:'explicit'}]}};
 assert.equal(presenterNotes(state,1),'供演练的稿子');assert.equal(state.segments.length,0);assert.equal(state.importedScript.originalText,'原稿不可覆盖');
});
