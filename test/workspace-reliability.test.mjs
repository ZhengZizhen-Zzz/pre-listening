import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspace} from '../public/workspace.mjs';
import {localRecords} from '../public/storage.mjs';
function fixture(t, overrides={}) {
 const original={...localRecords};t.after(()=>Object.assign(localRecords,original));
 const saved=new Map(),elements=new Map();
 const $=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',hidden:false,classList:{toggle(){}},addEventListener(type,handler){this[type]=handler;},querySelectorAll(){return[];}});return elements.get(id);};
 $('deck-name').textContent='测试材料';$('target-minutes').value='5';
 const state={pages:[{number:1,text:'材料'}],segments:[{id:'s1',page:1,text:'人工修订的发言',source:'edited'}],events:[{page:1,at:0}],duration:60,current:1,demo:false,recording:false,report:null};
 Object.assign(localRecords,{save:async record=>saved.set(record.id,structuredClone(record)),lastId:async()=>null,...overrides});
 const workspace=createWorkspace({state,$,escape:String,paragraphs:String,message(){},setBusy(v){state.busy=v;},health:async()=>{},api(){},getSession(){},renderPage:async()=>{},renderSegments(){},renderReport(){},view(){},resetSession(){state.segments=[];state.events=[];state.duration=null;state.report=null;},openPdf(){},attachAudio(){}});
 return {state,workspace,saved,$};
}
test('重新取转写前分出版本，原人工修订保留，同一音频不变成新一轮',async t=>{
 const {state,workspace,saved}=fixture(t);state.audioAssetId='audio';state.job='job';state.jobStatus='complete';state.jobTerms=['姓名'];state.previousRoundId='previous';state.recordingStatus='complete';
 await workspace.saveNow();const prior=workspace.snapshot();workspace.forkIfReviewed(true);state.segments=[{id:'s1',page:1,text:'服务识别原文'}];await workspace.saveNow();
 assert.equal(saved.get(prior.id).segments[0].text,'人工修订的发言');assert.notEqual(state.id,prior.id);assert.equal(state.roundId,prior.roundId);assert.equal(state.audioAssetId,prior.audioAssetId);assert.equal(state.previousRoundId,'previous');assert.equal(state.job,'job');
});
test('下一轮空白草稿保留真正上一轮及自定义热词',async t=>{
 const {state,workspace,$}=fixture(t);state.asrTerms=['赖坤'];const old=state.id;
 await workspace.boot();await $('next-rehearsal').click();
 assert.equal(state.previousRoundId,old);assert.notEqual(state.roundId,old);assert.equal(state.segments.length,0);assert.equal(state.referenceScript[0].text,'人工修订的发言');assert.deepEqual(state.asrTerms,['赖坤']);
});
test('暂存失败后不保存有缺口的后续片段，完整内存录音仍可最终保存',async t=>{
 const indexes=[];const {state,workspace}=fixture(t,{checkpointRecording:async(_r,_b,index)=>{indexes.push(index);if(index===1)throw new Error('quota');},finishRecording:async()=> 'complete-audio'});
 state.recordingStatus='recording';
 const tasks=[0,1,2].map(i=>workspace.checkpointRecording(new Blob(['part']),i,i+1));
 const outcomes=await Promise.allSettled(tasks);assert.deepEqual(outcomes.map(r=>r.status),['fulfilled','rejected','rejected']);assert.deepEqual(indexes,[0,1]);
 state.recordingStatus='complete';assert.equal(await workspace.finishRecording(new Blob(['all parts'])),true);assert.equal(state.audioAssetId,'complete-audio');assert.equal(state.unsaved,false);
});
test('最终保存失败保持可恢复状态，正常保存队列仍可继续工作',async t=>{
 const {state,workspace,saved}=fixture(t,{finishRecording:async()=>{throw new Error('quota');}});
 state.recordingStatus='complete';assert.equal(await workspace.finishRecording(new Blob(['all'])),false);assert.equal(state.recordingStatus,'interrupted');assert.equal(state.unsaved,true);assert.equal(state.audioAssetId,null);
 await workspace.saveNow();assert.equal(saved.get(state.id).recordingStatus,'interrupted');
});
test('转写任务编号、原提交术语和状态都进入可恢复记录',async t=>{
 const {state,workspace,saved}=fixture(t);Object.assign(state,{job:'accepted-task',jobStatus:'pending',jobTerms:['某姓名'],asrTerms:['后来更改'],jobError:'网络断开'});await workspace.saveNow();const record=saved.get(state.id);assert.equal(record.job,'accepted-task');assert.deepEqual(record.jobTerms,['某姓名']);assert.equal(record.jobStatus,'pending');assert.equal(record.jobError,'网络断开');
});
test('附件保存失败向调用方返回失败，不显示已成功',async t=>{
 const {state,workspace,$}=fixture(t,{saveAsset:async()=>{throw new Error('quota');}});assert.equal(await workspace.storeAsset(new Blob(['audio']),'audioAssetId'),false);assert.equal(state.audioAssetId,null);assert.equal(state.unsaved,true);assert.match($('save-status').textContent,/未保存/);
});

test('前两页临时预览不会覆盖已保存的完整材料或写入历史',async t=>{
 let closed=0;const {state,workspace,saved}=fixture(t,{saveAndClearActive:async()=>closed++});
 await workspace.saveNow();const before=structuredClone(saved.get(state.id));
 state.materialPending=true;state.pages=[{number:1,text:''},{number:2,text:''},{number:3,text:''}];
 workspace.saveSoon();assert.equal(await workspace.saveNow(),true);assert.equal(await workspace.saveAndClose(),true);
 assert.deepEqual(saved.get(state.id),before);assert.equal(closed,0);
 state.materialPending=false;await workspace.saveNow();assert.equal(saved.get(state.id).pages.length,3);
});
