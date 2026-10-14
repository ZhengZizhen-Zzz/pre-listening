import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisCache, analysisKey } from '../lib/analysis-cache.mjs';
test('证据校验未完成的报告可展示，但重试不能命中残缺报告缓存',async()=>{
  const cache=new AnalysisCache();let calls=0;
  const produce=()=>({evidenceRejected:++calls===1?1:0,issues:[]});
  const options={cacheable:report=>!report.evidenceRejected};
  assert.equal((await cache.getOrCreate('partial',produce,options)).report.evidenceRejected,1);
  assert.equal((await cache.getOrCreate('partial',produce,options)).cacheHit,false);
  assert.equal((await cache.getOrCreate('partial',produce,options)).cacheHit,true);
  assert.equal(calls,2);
});
import { validateSession } from '../public/core.mjs';

const session = () => validateSession({ pages: [{ text: '背景' }], segments: [{ id: 's1', page: 1, text: '我想说明这个问题。' }], audience: '同学', takeaways: '问题' });
test('相同输入同时请求或再次请求只生成一次，返回值互不污染', async () => {
  const cache = new AnalysisCache(); let calls = 0;
  const produce = async () => { calls++; return { issues: [{ title: '原建议' }] }; };
  const [first, second] = await Promise.all([cache.getOrCreate('a', produce), cache.getOrCreate('a', produce)]);
  assert.equal(calls, 1); assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true);
  first.report.issues[0].title = '改动';
  assert.equal((await cache.getOrCreate('a', produce)).report.issues[0].title, '原建议');
  assert.equal(calls, 1);
});
test('缓存命中不会触发已到额度的生成器，失败请求可以重试', async () => {
  const cache = new AnalysisCache();
  await assert.rejects(cache.getOrCreate('a', () => { throw new Error('服务失败'); }), /服务失败/);
  assert.equal((await cache.getOrCreate('a', () => ({ summary: '成功' }))).cacheHit, false);
  assert.equal((await cache.getOrCreate('a', () => { throw new Error('额度用尽'); })).cacheHit, true);
});
test('输入、目标或模型规则变化都会重新分析，密钥不参与结果标识', () => {
  const config = { provider: 'deepseek', model: 'test', key: 'secret1' }, s = session();
  const key = analysisKey(s, config, 'v1');
  assert.equal(key, analysisKey(s, { ...config, key: 'secret2' }, 'v1'));
  for (const [field, value] of [['takeaways', '结论'], ['audience', '专家'], ['targetSeconds', s.targetSeconds + 60]]) assert.notEqual(key, analysisKey({ ...s, [field]: value }, config, 'v1'));
  const changed = session(); changed.segments[0].text += '补充例子。';
  assert.notEqual(key, analysisKey(changed, config, 'v1'));
  assert.notEqual(key, analysisKey(s, { ...config, model: 'new' }, 'v1'));
  assert.notEqual(key, analysisKey(s, config, 'v2'));
});
test('过期或超过容量后重新生成，不无限保留材料结果', async () => {
  let time = 0, calls = 0; const cache = new AnalysisCache({ maxEntries: 1, ttlMs: 10, now: () => time });
  const produce = () => ({ generation: ++calls });
  await cache.getOrCreate('a', produce); time = 10;
  assert.equal((await cache.getOrCreate('a', produce)).cacheHit, false);
  await cache.getOrCreate('b', produce);
  assert.equal((await cache.getOrCreate('a', produce)).cacheHit, false);
  assert.equal(cache.entries.size, 1);
});
