import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {recognizePage,validateOcrImage} from '../lib/material-ocr.mjs';
import {validateSession,materialCoverage} from '../public/core.mjs';

test('OCR 仅接收有限大小的图片，不接受任意文件或路径',()=>{
  assert.throws(()=>validateOcrImage(Buffer.from('/etc/passwd')),/格式/);
  assert.throws(()=>validateOcrImage(Buffer.alloc(8*1024*1024+1)),/过大/);
});
test('本地OCR按图片去重，临时材料在任务后清理',async()=>{
  const bytes=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('synthetic-ocr-test')]);
  let file,calls=0;
  const runner=async(executable,args)=>{calls++;file=args[1];assert.deepEqual(await readFile(file),bytes);return {stdout:JSON.stringify({text:'研究结果：准确率提升',confidence:.8})};};
  const result=await recognizePage(bytes,runner);assert.equal(result.textSource,'ocr');assert.equal(result.confidence,.8);
  await assert.rejects(access(file));
  assert.equal((await recognizePage(bytes,runner)).cacheHit,true);assert.equal(calls,1);
});
test('图片识别来源保留到分析输入，空识别结果仍标为缺失',()=>{
  const session=validateSession({pages:[{text:'模型验证',textSource:'ocr'},{text:'',textSource:'ocr'}],segments:[{id:'s1',page:1,text:'我负责模型验证。'}]});
  assert.equal(session.pages[0].textSource,'ocr');assert.deepEqual(materialCoverage(session.pages).ocrPages,[1,2]);assert.deepEqual(materialCoverage(session.pages).missingPages,[2]);
});
