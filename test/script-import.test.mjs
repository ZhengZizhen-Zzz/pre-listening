import test from 'node:test';
import assert from 'node:assert/strict';
import {splitScript,associateScript,cleanImportedScript,importedScriptSources} from '../public/script-import-core.mjs';
import {decodeScript,readScriptFile} from '../public/script-reader.mjs';
const pages=[{number:1,text:'研究背景\n城市通勤拥堵与交通效率'},{number:2,text:'实验设计\n随机分组开展对照实验，比较干预前后的差异。'},{number:3,text:'研究结论\n汇总实验结果与下一步验证。'}];
test('explicit markers support Chinese, full-width and English; invalid pages never fall back to page one',()=>{
 const parts=splitScript('开场白\n第２页：实验设计\n说明随机分组\n第十页\n后续说明\nSlide 3: 结论',3);
 assert.deepEqual(parts.map(p=>p.page),[0,2,2,0,0,3]);
 const linked=associateScript(parts,pages);assert.equal(linked[3].page,0);assert.equal(linked[4].page,0);
});
test('unmarked content is matched conservatively and ambiguous generic text remains unassigned',()=>{
 const linked=associateScript(splitScript('实验设计：通过随机分组开展对照实验，比较干预前后的差异。\n谢谢大家，我的汇报结束了。',3),pages);
 assert.equal(linked[0].page,2);assert.equal(linked[0].link,'suggested');assert.equal(linked[1].page,0);
 const ambiguous=associateScript(splitScript('随机分组开展对照实验。',2),[{number:1,text:'随机分组开展对照实验。'},{number:2,text:'随机分组开展对照实验。'}]);assert.equal(ambiguous[0].page,0);
});
test('manual links and explicit pages survive rematching; PDF physical page is not a PPT page',()=>{
 const parts=[{id:'p1',text:'实验设计',page:1,link:'manual'},{id:'p2',text:'实验设计',page:3,link:'explicit'}];assert.deepEqual(associateScript(parts,pages),parts);
 const unmarked=splitScript('一些讲稿\n\n更多讲稿',3);assert.ok(unmarked.every(p=>p.page===0));
});
test('long paragraphs split at sentence boundaries without dropping words',()=>{
 const raw=('这是测试句子，不能丢字。').repeat(100),parts=splitScript(raw,3);assert.ok(parts.length>1);assert.equal(parts.map(p=>p.text).join(''),raw);
 assert.throws(()=>splitScript('a'.repeat(120001),3));assert.throws(()=>splitScript('x\n'.repeat(801),3));
});
test('original text remains immutable after editing and backup sanitation rejects invalid structures',()=>{
 const originalText='第一段原稿\n第二段原稿',script={name:'原稿.txt',originalText,parts:splitScript(originalText,3)};
 script.parts[0].text='编辑稿';const clean=cleanImportedScript(script,3);assert.equal(clean.originalText,originalText);assert.equal(clean.parts[0].text,'编辑稿');
 assert.equal(cleanImportedScript({...script,parts:[...script.parts,script.parts[0]]},3),null);
 assert.equal(cleanImportedScript({...script,originalText:5},3),null);
 assert.equal(cleanImportedScript({...script,assetId:'other-users-asset'},3).assetId,undefined);
});
test('unassigned script is usable as full text in presenter and original always available',()=>{
 const s={originalText:'完整原稿',parts:[{text:'逐页稿',page:2},{text:'未分配稿',page:0}]};
 const sources=importedScriptSources(s,2);assert.equal(sources[0].text,'逐页稿');assert.ok(sources.find(s=>s.id==='imported-full').text.includes('未分配稿'));assert.equal(sources.at(-1).text,'完整原稿');
 assert.equal(importedScriptSources(s,1)[0].id,'imported-full');
});
test('text encodings preserve Chinese and file validation fails before any upload',async()=>{
 assert.equal(decodeScript(new TextEncoder().encode('中文讲稿')),'中文讲稿');assert.equal(decodeScript(Uint8Array.from([255,254,45,78])),'中');
 const file=new File(['第1页\n讲稿正文'],'稿.txt');assert.match(await readScriptFile(file),/讲稿正文/);
 await assert.rejects(readScriptFile(new File(['x'],'稿.doc')),/DOCX/);
 const controller=new AbortController();controller.abort();await assert.rejects(readScriptFile(file,{signal:controller.signal}),{name:'AbortError'});
});
test('PDF extracts incrementally without turning its page numbers into PPT assignments; scanned pages fail visibly',async()=>{
 let destroyed=false,progress=[];
 const pdf={numPages:2,getPage:async i=>({getTextContent:async()=>({items:[{str:'讲稿段落'+i,hasEOL:true}]}),cleanup(){}}),destroy:async()=>{destroyed=true;}};
 const text=await readScriptFile(new File(['%PDF'],'稿.pdf'),{openPdf:async()=>pdf,onProgress:(t,n)=>progress.push(n)});assert.deepEqual(progress,[1,2]);assert.ok(destroyed);assert.ok(splitScript(text,3).every(p=>p.page===0));
 await assert.rejects(readScriptFile(new File(['%PDF'],'扫描.pdf'),{openPdf:async()=>({...pdf,getPage:async()=>({getTextContent:async()=>({items:[]}),cleanup(){}})})}),/没有文字层/);
});
