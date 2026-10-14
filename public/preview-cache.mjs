// The digest covers file contents, not names or timestamps. A changed deck
// must never reuse a stale preview, even if saved under the same name.
export async function previewKey(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return `pdf-preview-v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createPreviewCache(records) {
  const indexKey = 'recent-ppt-previews-v1';
  return {
    async find(file) {
      // Avoid an additional full-file allocation before uploading large decks.
      if(file.size>64*1024*1024)return {key:null,blob:null};
      try {
        const key = await previewKey(file);
        const entries = await records.getMeta(indexKey) || [];
        const entry = entries.find(item => item.key === key);
        const blob = entry ? await records.getAsset(entry.assetId) : null;
        return {key, blob: blob?.size ? blob : null, assetId: blob?.size ? entry.assetId : null,...(entry?.notes?{notes:entry.notes}:{})};
      } catch { return {key: null, blob: null}; }
    },
    async remember(key, assetId, notes=null) {
      if (!key || !assetId) return;
      try {
        const entries = await records.getMeta(indexKey) || [];
        // Only references are retained; history owns the PDF blobs. No second
        // copy of a potentially large deck and no deletion of history assets.
        await records.setMeta(indexKey, [{key, assetId,...(notes?.status==='complete'?{notes}: {})}, ...entries.filter(entry => entry.key !== key)].slice(0, 8));
      } catch { /* A cache failure must not fail an otherwise saved import. */ }
    }
  };
}
