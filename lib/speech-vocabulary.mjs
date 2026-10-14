import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanSpeechTerms } from '../public/speech-terms.mjs';

const dataDir = process.env.TRIAL_DIR || process.env.REHEARSAL_DATA_DIR;
const journal = dataDir ? path.join(path.resolve(dataDir),'speech-vocabulary-owned.json') : fileURLToPath(new URL('../../../work/speech-vocabulary-owned.json', import.meta.url));
const owned = new Map();
let writes = Promise.resolve();
async function save() {
  const snapshot = JSON.stringify([...owned]);
  writes = writes.catch(() => {}).then(async () => { await mkdir(dirname(journal), {recursive:true}); await writeFile(journal, snapshot, {mode:0o600}); });
  await writes;
}
async function call(input, config, fetcher) {
  const response = await fetcher('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/customization', {
    method:'POST', headers:{Authorization:`Bearer ${config.asrKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:'speech-biasing',input}), signal:AbortSignal.timeout(15000), redirect:'error'
  });
  if (!response.ok) throw new Error('热词服务暂不可用');
  const data = await response.json();
  return data.output;
}
export async function removeSpeechVocabulary(id, config, fetcher = fetch) {
  if (!id || !owned.has(id)) return false;
  try {
    await call({action:'delete_vocabulary',vocabulary_id:id},config,fetcher);
    owned.delete(id); await save(); return true;
  } catch { return false; }
}
export async function recoverSpeechVocabularies(config, protectedIds = new Set()) {
  try { for (const [id, created] of JSON.parse(await readFile(journal,'utf8'))) if (typeof id === 'string' && id.startsWith('vocab-rehearsal-') && Number.isFinite(created)) owned.set(id,created); } catch {}
  if (!config.asrKey) return;
  for (const [id, created] of owned) if (!protectedIds.has(id) && Date.now() - created > 3600000) await removeSpeechVocabulary(id,config);
}
export async function createSpeechVocabulary(values, config, fetcher = fetch) {
  const terms = cleanSpeechTerms(values);
  if (!terms.length) return null;
  const result = await call({action:'create_vocabulary',target_model:config.asrModel,prefix:'rehearsal',vocabulary:terms.map(text => ({text,weight:4}))},config,fetcher);
  const id = result?.vocabulary_id;
  if (typeof id !== 'string' || !id.startsWith('vocab-rehearsal-')) throw new Error('热词列表创建失败');
  owned.set(id,Date.now());
  try {
    await save();
    for (let attempt=0;attempt<4;attempt++) {
      const status = await call({action:'query_vocabulary',vocabulary_id:id},config,fetcher);
      if (status?.status === 'OK') return id;
      await delay(500);
    }
    throw new Error('热词尚未准备好');
  } catch(error) { await removeSpeechVocabulary(id,config,fetcher); throw error; }
}
