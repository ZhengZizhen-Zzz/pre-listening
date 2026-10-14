import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync,crc32} from 'node:zlib';
import {readZipDirectory,firstPptxPages} from '../public/pptx-first-pages.mjs';
function zip(text,{name='ppt/presentation.xml',padding=0,method=8,crc=crc32(Buffer.from(text)),claimedSize}={}){
 const filename=Buffer.from(name),raw=Buffer.from(text),data=method===8?deflateRawSync(raw):raw;
 const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(method,8);h.writeUInt16LE(filename.length,26);
 const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(claimedSize??raw.length,24);c.writeUInt16LE(filename.length,28);c.writeUInt32LE(padding,42);
 const e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(1,8);e.writeUInt16LE(1,10);e.writeUInt32LE(c.length+filename.length,12);e.writeUInt32LE(padding+h.length+filename.length+data.length,16);
 return new Blob([new Uint8Array(padding),h,filename,data,c,filename,e]);
}
test('early preview ZIP reader reads only selected parts, validates stored and deflated data',async()=>{
 for(const method of [0,8]){
  const file=zip('<slide/>',{padding:32*1024**2,method});let bytes=0;
  const directory=await readZipDirectory({size:file.size,slice(start,end=file.size){bytes+=end-start;return file.slice(start,end);}});
  assert.equal(await directory.text('ppt/presentation.xml'),'<slide/>');assert.ok(bytes<100000);
 }
});
test('early preview rejects corrupt XML, oversized decompression and traversal',async()=>{
 await assert.rejects(readZipDirectory(zip('x',{name:'../escape'})));
 for(const file of [zip('x',{crc:123}),zip(' '.repeat(5*1024**2),{claimedSize:1})]){
  const directory=await readZipDirectory(file);await assert.rejects(directory.text('ppt/presentation.xml'));
 }
 assert.equal(await firstPptxPages(new Blob(['broken'])),null);
});
test('early preview cancellation propagates instead of starting a fallback upload',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(firstPptxPages(zip('x'),{signal:controller.signal}),{name:'AbortError'});
});
