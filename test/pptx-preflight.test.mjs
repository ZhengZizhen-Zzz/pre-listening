import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {countPresentationSlides,readPptxPageCount} from '../public/pptx-preflight.mjs';
import {validateMaterialPages} from '../public/material-limits.mjs';

const ns='http://schemas.openxmlformats.org/presentationml/2006/main';
const xml=(count,prefix='p')=>`<${prefix}:presentation xmlns:${prefix}="${ns}"><${prefix}:sldIdLst>${Array.from({length:count},(_,i)=>`<${prefix}:sldId id="${256+i}" r:id="rId${i+1}"/>`).join('')}</${prefix}:sldIdLst></${prefix}:presentation>`;
function zip(content,{method=8,padding=0,encrypted=false,claimedSize}={}){
  const name=Buffer.from('ppt/presentation.xml'),raw=Buffer.from(content),body=method===8?deflateRawSync(raw):raw;
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(method,8);header.writeUInt16LE(name.length,26);
  const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(encrypted?1:0,8);directory.writeUInt16LE(method,10);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(claimedSize??raw.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(padding,42);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(directory.length+name.length,12);end.writeUInt32LE(padding+header.length+name.length+body.length,16);
  return new Blob([new Uint8Array(padding),header,name,body,directory,name,end]);
}
test('counts the actual presentation list for alternate prefixes and ignores comments',()=>{
  assert.equal(countPresentationSlides(xml(60,'deck')),60);
  assert.equal(countPresentationSlides(xml(3).replace('<p:sldIdLst>','<!-- <p:sldId id="999"/> --><p:sldIdLst>')),3);
  assert.equal(countPresentationSlides('<p:sldId id="1"/>'),null);
  assert.equal(countPresentationSlides(xml(0)),null);
});
test('stored and deflated PPTX count before uploading, preserving the inclusive 60-page boundary',async()=>{
  for(const method of [0,8]){
    assert.equal(await readPptxPageCount(zip(xml(60),{method})),60);
    const count=await readPptxPageCount(zip(xml(61),{method}));
    assert.equal(count,61);assert.throws(()=>validateMaterialPages(count),/60/);
  }
});
test('large media does not require reading the entire deck to count slides',async()=>{
  const file=zip(xml(61),{padding:64*1024**2});let readBytes=0;
  const count=await readPptxPageCount({size:file.size,slice(start,end=file.size){readBytes+=end-start;return file.slice(start,end);}});
  assert.equal(count,61);assert.ok(readBytes<100000,`read ${readBytes} bytes`);
});
test('unsupported or damaged ZIP falls back, with bounded decompression',async()=>{
  assert.equal(await readPptxPageCount(new Blob(['not a zip'])),null);
  assert.equal(await readPptxPageCount(zip(xml(2),{encrypted:true})),null);
  assert.equal(await readPptxPageCount(zip(xml(2),{method:12})),null);
  assert.equal(await readPptxPageCount(zip(xml(2),{claimedSize:1})),null);
  assert.equal(await readPptxPageCount(zip(xml(2)+' '.repeat(1024**2),{claimedSize:1})),null);
  const file=zip(xml(2)),bytes=new Uint8Array(await file.arrayBuffer());bytes[0]=0;
  assert.equal(await readPptxPageCount(new Blob([bytes])),null);
});
