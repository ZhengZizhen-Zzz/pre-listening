import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewRenderer,previewFailure,previewGeometry} from '../public/preview-renderer.mjs';

function setup(){
  const canvases=[],commits=[];
  const renderer=createPreviewRenderer({createCanvas(){const canvas={width:0,height:0,getContext(){return {canvas};}};canvases.push(canvas);return canvas;},commit(canvas,geometry){commits.push({canvas,width:canvas.width,height:canvas.height,geometry});}});
  return {renderer,canvases,commits};
}
const size={width:1024,height:600,pixelRatio:2};
const page=render=>({getViewport:({scale})=>({width:1000*scale,height:560*scale}),render});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('rapid page changes commit only the latest page, using separate canvases',async()=>{
  const {renderer,canvases,commits}=setup(),old=deferred();let cancelled=0;
  const first=renderer.render(page(()=>({promise:old.promise,cancel(){cancelled++;}})),size);
  const second=renderer.render(page(()=>({promise:Promise.resolve(),cancel(){}})),size);
  assert.equal((await second).status,'complete');old.resolve();
  assert.equal((await first).status,'cancelled');assert.equal(cancelled,1);
  assert.equal(commits.length,1);assert.equal(commits[0].canvas,canvases[1]);assert.notEqual(canvases[0],canvases[1]);
  assert.ok(canvases.every(c=>c.width===0&&c.height===0));
});
test('an old render failing after a new success cannot show a stale failure',async()=>{
  const {renderer,commits}=setup(),old=deferred();
  const first=renderer.render(page(()=>({promise:old.promise,cancel(){}})),size);
  await renderer.render(page(()=>({promise:Promise.resolve(),cancel(){}})),size);
  old.reject(new Error('network failed'));assert.equal((await first).status,'cancelled');assert.equal(commits.length,1);
});
test('memory pressure retries once with lower resolution and fresh storage',async()=>{
  const {renderer,canvases,commits}=setup(),widths=[];
  const result=await renderer.render(page(({canvasContext})=>{widths.push(canvasContext.canvas.width);return {promise:widths.length===1?Promise.reject(new RangeError('allocation failed')):Promise.resolve(),cancel(){}};}),size);
  assert.equal(result.status,'complete');assert.equal(result.attempts,2);assert.ok(widths[1]<widths[0]);assert.equal(commits.length,1);assert.equal(canvases.length,2);
});
test('persistent memory errors and missing browser APIs stop with recoverable failure',async()=>{
  for(const [error,expected] of [[new RangeError('allocation failed'),2],[new TypeError('Uint8Array.toBase64 is not a function'),1]]){
    const {renderer,canvases,commits}=setup();
    const result=await renderer.render(page(()=>({promise:Promise.reject(error),cancel(){}})),size);
    assert.equal(result.status,'failed');assert.equal(result.attempts,expected);assert.equal(commits.length,0);assert.ok(canvases.every(c=>c.width===0));
  }
});
test('manual retry can succeed after a failed render and explicit cancellation never commits',async()=>{
  const {renderer,commits}=setup();
  assert.equal((await renderer.render(page(()=>({promise:Promise.reject(new Error('bad resource')),cancel(){}})),size)).status,'failed');
  assert.equal((await renderer.render(page(()=>({promise:Promise.resolve(),cancel(){}})),size)).status,'complete');
  const pending=deferred(),last=renderer.render(page(()=>({promise:pending.promise,cancel(){}})),size);renderer.cancel();pending.resolve();assert.equal((await last).status,'cancelled');assert.equal(commits.length,1);
});
test('preview allocation stays bounded on large high-density monitors, and supports small PDF pages',()=>{
  for(const [width,height,density] of [[7680,4320,3],[14000,14000,8],[1024,600,2]]){
    const base={width:1000,height:560},g=previewGeometry(base,width,height,density);
    assert.ok(base.width*g.scale<=4096);assert.ok(base.height*g.scale<=4096);
    assert.ok(base.width*base.height*g.scale**2<=5_000_001);
    assert.ok(g.cssWidth<=width-24&&g.cssHeight<=height-24);
  }
  assert.doesNotThrow(()=>previewGeometry({width:20,height:10},600,400));
  assert.throws(()=>previewGeometry({width:100,height:0},600,400));
});
test('failure messages classify known causes without exposing raw document errors',()=>{
  assert.equal(previewFailure(new TypeError('Math.sumPrecise is not a function')).code,'browser_unsupported');
  assert.equal(previewFailure(new Error('Cannot use the same canvas during multiple render() operations.')).code,'render_conflict');
  assert.equal(previewFailure(new Error('Failed to fetch resource')).code,'render_resource');
  assert.equal(previewFailure(new RangeError('allocation failed')).code,'render_memory');
  assert.equal(previewFailure(new Error('private document text')).code,'preview_failed');
  assert.doesNotMatch(JSON.stringify(previewFailure(new Error('private document text'))),/private document/);
});
