import {appendRecordingPart} from './recording-parts.mjs';
let database;
function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    let abandoned = false;
    const request = indexedDB.open('rehearsal-studio', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('recordingChunks')) db.createObjectStore('recordingChunks', { keyPath: ['recordId', 'index'] });
    };
    request.onsuccess = () => { if (abandoned) { request.result.close(); return; } request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => { abandoned = true; database = null; reject(new Error('请关闭其他演练页面后重试保存。')); };
  });
  return database;
}

async function transaction(stores, mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error || new Error('本机保存失败'));
    tx.onabort = () => reject(tx.error || new Error('本机保存中断'));
    try { result = action(tx); } catch (error) { tx.abort(); reject(error); }
  });
}

export const localRecords = {
  // Training lives in its own namespace and never changes the active full round.
  saveTraining(run) { return transaction(['meta'], 'readwrite', tx => tx.objectStore('meta').put(run, `training-run:${run.id}`)); },
  async listTraining(parentId) {
    const runs = await transaction(['meta'], 'readonly', tx => tx.objectStore('meta').getAll(IDBKeyRange.bound('training-run:', 'training-run:\uffff')));
    return runs.filter(run => run.parentId === parentId).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  checkpointTraining(run, attemptId, blob, index) {
    return transaction(['meta','recordingChunks'], 'readwrite', tx => {
      tx.objectStore('recordingChunks').put({recordId:`training:${attemptId}`,index,blob});
      return tx.objectStore('meta').put(run, `training-run:${run.id}`);
    });
  },
  async finishTraining(run, attemptId, blob) {
    const record = structuredClone(run), id = crypto.randomUUID();
    const attempt = record.turns.flatMap(t => t.attempts).find(a => a.id === attemptId);
    if (!attempt) throw new Error('练习记录不存在，录音尚未保存。');
    attempt.audioParts=appendRecordingPart(attempt,id);
    attempt.audioAssetId = id;
    await transaction(['meta','assets','recordingChunks'], 'readwrite', tx => {
      tx.objectStore('assets').put(blob,id);
      tx.objectStore('recordingChunks').delete(IDBKeyRange.bound([`training:${attemptId}`,0],[`training:${attemptId}`,Number.MAX_SAFE_INTEGER]));
      return tx.objectStore('meta').put(record, `training-run:${run.id}`);
    });
    return id;
  },
  async recoverTraining(run) {
    const record = structuredClone(run);
    for (const attempt of record.turns.flatMap(t => t.attempts)) {
      if (attempt.recordingStatus !== 'recording') continue;
      const chunks = await transaction(['recordingChunks'], 'readonly', tx => tx.objectStore('recordingChunks').getAll(IDBKeyRange.bound([`training:${attempt.id}`,0],[`training:${attempt.id}`,Number.MAX_SAFE_INTEGER])));
      attempt.recordingStatus = 'interrupted';
      // Checkpoints carry the last saved prefix duration, excluding background time.
      if (chunks?.length) {
        const id=await this.finishTraining(record,attempt.id,new Blob(chunks.map(c => c.blob),{type:chunks[0].blob.type}));
        attempt.audioParts=appendRecordingPart(attempt,id);attempt.audioAssetId=id;
      }
    }
    await this.saveTraining(record);
    return record;
  },
  getMeta(key) { return transaction(['meta'], 'readonly', tx => tx.objectStore('meta').get(key)); },
  setMeta(key, value) { return transaction(['meta'], 'readwrite', tx => tx.objectStore('meta').put(value, key)); },
  // Preserve the record and its assets, but leave the workspace empty on reload.
  saveAndClearActive(record) {
    return transaction(['records', 'meta'], 'readwrite', tx => {
      tx.objectStore('records').put(record);
      return tx.objectStore('meta').delete('lastRecordId');
    });
  },
  async save(record) {
    return transaction(['records', 'meta'], 'readwrite', tx => {
      tx.objectStore('records').put(record);
      return tx.objectStore('meta').put(record.id, 'lastRecordId');
    });
  },
  get(id) { return transaction(['records'], 'readonly', tx => tx.objectStore('records').get(id)); },
  async list() {
    const records = await transaction(['records'], 'readonly', tx => tx.objectStore('records').getAll());
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  lastId() { return transaction(['meta'], 'readonly', tx => tx.objectStore('meta').get('lastRecordId')); },
  async saveAsset(blob) {
    const id = crypto.randomUUID();
    await transaction(['assets'], 'readwrite', tx => tx.objectStore('assets').put(blob, id));
    return id;
  },
  async checkpointRecording(record, blob, index) {
    if (!Number.isSafeInteger(index) || index < 0 || !(blob instanceof Blob)) throw new Error('录音片段格式不正确。');
    return transaction(['records', 'meta', 'recordingChunks'], 'readwrite', tx => {
      tx.objectStore('recordingChunks').put({ recordId: record.id, index, blob });
      tx.objectStore('records').put(record);
      return tx.objectStore('meta').put(record.id, 'lastRecordId');
    });
  },
  async finishRecording(record, blob) {
    const id = crypto.randomUUID();
    await transaction(['records', 'assets', 'recordingChunks', 'meta'], 'readwrite', tx => {
      tx.objectStore('assets').put(blob, id);
      tx.objectStore('records').put({ ...record, audioAssetId: id, audioParts:appendRecordingPart(record,id) });
      tx.objectStore('recordingChunks').delete(IDBKeyRange.bound([record.id, 0], [record.id, Number.MAX_SAFE_INTEGER]));
      return tx.objectStore('meta').put(record.id, 'lastRecordId');
    });
    return id;
  },
  async recoverRecording(record) {
    const continuation = Number(record.recordingOffset) > 0;
    if (record.recordingStatus !== 'recording' && !(record.recordingStatus === 'interrupted' && (!record.audioAssetId || continuation))) return record;
    const chunks = await transaction(['recordingChunks'], 'readonly', tx => tx.objectStore('recordingChunks').getAll(IDBKeyRange.bound([record.id, 0], [record.id, Number.MAX_SAFE_INTEGER])));
    if (!chunks?.length) { const empty = { ...record, recordingStatus: 'interrupted' }; await this.save(empty); return empty; }
    const blob = new Blob(chunks.map(chunk => chunk.blob), { type: record.recordingMime || chunks[0].blob.type || 'audio/webm' });
    const recovered = { ...record, recordingStatus: 'interrupted', updatedAt: new Date().toISOString() };
    recovered.audioAssetId = await this.finishRecording(recovered, blob);
    recovered.audioParts = appendRecordingPart(record,recovered.audioAssetId);
    return recovered;
  },
  getAsset(id) { return id ? transaction(['assets'], 'readonly', tx => tx.objectStore('assets').get(id)) : Promise.resolve(null); }
};
