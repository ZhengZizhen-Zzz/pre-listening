import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { prepareAsset, sendAsset } from '../lib/client-assets.mjs';

test('静态资源压缩可还原原文，缓存协商及HEAD保持正确',async()=>{
  const original=Buffer.from('页面测试 hello '.repeat(1000));
  const asset=await prepareAsset(original,'text/javascript','private, max-age=31536000, immutable');
  const response=()=>({writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}});
  let res=response();sendAsset({method:'GET',headers:{'accept-encoding':'gzip, br'}},res,asset);
  assert.equal(res.headers['Content-Encoding'],'br');assert.deepEqual(brotliDecompressSync(res.body),original);assert.ok(res.body.length<original.length/10);
  res=response();sendAsset({method:'GET',headers:{'accept-encoding':'br;q=0, gzip'}},res,asset);assert.equal(res.headers['Content-Encoding'],'gzip');assert.deepEqual(gunzipSync(res.body),original);
  res=response();sendAsset({method:'GET',headers:{'if-none-match':asset.etag}},res,asset);assert.equal(res.status,304);assert.equal(res.body,undefined);
  res=response();sendAsset({method:'HEAD',headers:{}},res,asset);assert.equal(res.status,200);assert.equal(res.headers['Content-Length'],original.length);assert.equal(res.body,undefined);
});
