// Shared by the browser and local converter; audio has a separate limit.
export const MAX_DECK_MB = 500;
export const MAX_DECK_PAGES = 60;
export const MAX_DECK_BYTES = MAX_DECK_MB * 1024 * 1024;
export const MAX_PREVIEW_BYTES = MAX_DECK_BYTES;
export const CONVERSION_TIMEOUT_MS = 300000;
export const IMPORT_TIMEOUT_MS = CONVERSION_TIMEOUT_MS + 15000;
export const UPLOAD_CHUNK_BYTES = 1 * 1024 * 1024;
export const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
// Compact previews fit in one request; large originals retain resumable chunks.
export const INLINE_UPLOAD_BYTES = 8 * 1024 * 1024;
export const PREVIEW_WAIT_MS = 8000;

export function validateMaterialPages(count) {
  if (Number.isInteger(count) && count > MAX_DECK_PAGES) throw Object.assign(new Error(`这份材料有 ${count} 页，一次最多演练 ${MAX_DECK_PAGES} 页。请保留本次要讲的部分后再导入。`), { status: 400, code: 'page_limit' });
  if (!Number.isInteger(count) || count < 1) throw Object.assign(new Error(`请提供 1–${MAX_DECK_PAGES} 页材料。`), { status: 400, code: 'page_limit' });
}

export function validateMaterialSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw Object.assign(new Error('材料文件为空或大小无效。'), { status: 400 });
  if (size > MAX_DECK_BYTES) throw Object.assign(new Error(`材料超过 ${MAX_DECK_MB} MB。请压缩图片、移除内嵌视频，或导出为 PDF 后再导入。`), { status: 413 });
}
