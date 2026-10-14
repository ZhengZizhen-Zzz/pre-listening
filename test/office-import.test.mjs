import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { validateOfficeUpload, convertOfficeToPdf, MAX_DECK_BYTES } from '../lib/office-import.mjs';
import { CONVERSION_TIMEOUT_MS, IMPORT_TIMEOUT_MS, validateMaterialSize } from '../public/material-limits.mjs';

const zip = Buffer.from([0x50,0x4b,0x03,0x04,1,2,3]);
test('rejects unsupported, mismatched, empty and oversized Office uploads before conversion', () => {
  assert.throws(() => validateOfficeUpload(zip, 'pptm'), /请选择/);
  assert.throws(() => validateOfficeUpload(zip, 'ppt'), /不符/);
  assert.throws(() => validateOfficeUpload(Buffer.alloc(0), 'pptx'), /为空/);
  assert.throws(() => validateOfficeUpload({length:MAX_DECK_BYTES + 1}, 'pptx'), e => e.status === 413);
});
test('32 MB image-heavy slides pass the same limit used in the browser and converter', () => {
  const bytes = Buffer.alloc(33 * 1024 * 1024);
  zip.copy(bytes);
  assert.doesNotThrow(() => validateMaterialSize(bytes.length));
  assert.doesNotThrow(() => validateOfficeUpload(bytes, 'pptx'));
  assert.doesNotThrow(() => validateMaterialSize(MAX_DECK_BYTES));
  assert.throws(() => validateMaterialSize(MAX_DECK_BYTES + 1), e => e.status === 413 && /500 MB/.test(e.message));
  assert.throws(() => validateMaterialSize(NaN), e => e.status === 400);
});
test('a preview above the old 40 MB ceiling can be returned and temporary files are removed', async () => {
  let directory;
  const pdf = await convertOfficeToPdf(zip, 'pptx', '/test/converter', async (_exe, args) => {
    const output = args[args.indexOf('--outdir') + 1]; directory = path.dirname(output);
    const bytes = Buffer.alloc(41 * 1024 * 1024); bytes.write('%PDF-');
    await writeFile(path.join(output, 'presentation.pdf'), bytes);
  });
  assert.equal(pdf.length, 41 * 1024 * 1024);
  await assert.rejects(access(directory), e => e.code === 'ENOENT');
});
test('missing converter has a usable PDF fallback message', async () => {
  await assert.rejects(convertOfficeToPdf(zip, 'pptx', null), e => e.status === 503 && /PDF/.test(e.message));
});
test('successful conversion uses fixed local paths and removes all temporary material', async () => {
  let directory;
  const pdf = await convertOfficeToPdf(zip, 'pptx', '/test/converter', async (executable, args, options) => {
    assert.equal(executable, '/test/converter');
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, CONVERSION_TIMEOUT_MS);
    assert.ok(IMPORT_TIMEOUT_MS > options.timeout);
    const output = args[args.indexOf('--outdir') + 1]; directory = path.dirname(output);
    assert.equal(path.basename(args.at(-1)), 'presentation.pptx');
    await writeFile(path.join(output, 'presentation.pdf'), '%PDF-test fixture');
  });
  assert.equal(pdf.toString(), '%PDF-test fixture');
  await assert.rejects(access(directory), e => e.code === 'ENOENT');
});
test('timed-out conversion cleans up and returns a sanitized actionable error', async () => {
  let directory;
  await assert.rejects(convertOfficeToPdf(zip, 'pptx', '/test/converter', async (_exe, args) => {
    directory = path.dirname(args.at(-1)); throw Object.assign(new Error('private raw log'), { killed: true });
  }), e => e.status === 422 && /超过 5 分钟/.test(e.message) && !e.message.includes('private'));
  await assert.rejects(access(directory), e => e.code === 'ENOENT');
});
test('converter exit success without a valid PDF is not reported as success', async () => {
  await assert.rejects(convertOfficeToPdf(zip, 'pptx', '/test/converter', async (_exe, args) => {
    await writeFile(path.join(args[args.indexOf('--outdir')+1], 'presentation.pdf'), '<html>error</html>');
  }), e => e.status === 422);
});
