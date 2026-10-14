import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeText, readMissingText } from '../public/material-text.mjs';

test('页面文字逐页交付，读取第40页前第一页已可用，不截断材料',async()=>{
  const delivered=[];
  const pdf={getPage:async n=>({getTextContent:async()=>{if(n===40)assert.equal(delivered.length,39);return {items:[{str:`page ${n}`,hasEOL:true}]};}})};
  const pages=await readNativeText(pdf,Array.from({length:40},(_,i)=>({number:i+1,text:''})),{onPage:page=>delivered.push(page)});
  assert.equal(pages.length,40);assert.equal(pages[39].text,'page 40');assert.equal(delivered[0].text,'page 1');
});
test('切换材料取消旧任务后，延迟返回的文字不能写入新材料',async()=>{
  const controller=new AbortController();let release;const gate=new Promise(resolve=>release=resolve);const delivered=[];
  const pdf={getPage:async()=>({getTextContent:async()=>{await gate;return {items:[{str:'old'}]};}})};
  const reading=readNativeText(pdf,[{number:1,text:''}],{signal:controller.signal,onPage:page=>delivered.push(page)});
  controller.abort();release();await assert.rejects(reading,{name:'AbortError'});assert.equal(delivered.length,0);
});
test('OCR取消会释放画布，旧结果不会覆盖材料',async t=>{
  const old=globalThis.document;const canvas={width:0,height:0,getContext:()=>({}),toBlob:callback=>callback(new Blob(['image']))};
  globalThis.document={createElement:()=>canvas};t.after(()=>{globalThis.document=old;});
  const controller=new AbortController(),delivered=[];
  const pdf={getPage:async()=>({getViewport:()=>({width:100,height:100}),render:()=>({promise:Promise.resolve(),cancel(){}})})};
  const reading=readMissingText(pdf,[{number:1,text:''}],{signal:controller.signal,onPage:p=>delivered.push(p),recognize:async()=>{controller.abort();return {text:'old'};}});
  await assert.rejects(reading,{name:'AbortError'});assert.equal(delivered.length,0);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
});
