import { access, mkdtemp, mkdir, readFile, writeFile, stat, rm, open, copyFile, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MAX_DECK_BYTES, MAX_DECK_MB, MAX_PREVIEW_BYTES, CONVERSION_TIMEOUT_MS, validateMaterialSize } from '../public/material-limits.mjs';

const execute = promisify(execFile);
const fail = (message, status = 400, code = 'invalid_format') => { throw Object.assign(new Error(message), { status, code }); };
export { MAX_DECK_BYTES };
export async function findOfficeConverter() {
  const candidates = [process.env.SOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/libreoffice', '/usr/bin/soffice'];
  for (const file of candidates.filter(Boolean)) {
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  return null;
}

export function validateOfficeUpload(bytes, extension, size = bytes.length) {
  if (!['ppt', 'pptx'].includes(extension)) fail('请选择 PPT、PPTX 或 PDF 文件。');
  validateMaterialSize(size);
  const ole = Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]);
  if (extension === 'pptx' && bytes.subarray(0,8).equals(ole)) fail('这份 PPTX 可能设置了打开密码，或实际为旧版 PPT。请在 WPS / PowerPoint 中取消打开密码并另存为 PPTX 后再导入。', 422, 'protected_or_mislabeled');
  const signature = extension === 'pptx' ? Buffer.from([0x50,0x4b,0x03,0x04]) : ole;
  if (!bytes.subarray(0, signature.length).equals(signature)) fail('文件内容与格式不符。请用 WPS / PowerPoint 打开后重新另存为 PPTX 或 PDF，不要只修改文件后缀。');
}

export async function validateOfficeFile(file, extension) {
  const info = await stat(file), handle = await open(file, 'r');
  try { const head = Buffer.alloc(8); await handle.read(head,0,8,0); validateOfficeUpload(head,extension,info.size); }
  finally { await handle.close(); }
}

// New imports remain on disk while queued; never collect a 500 MB upload in RAM.
export async function convertOfficeFileToPdf(file, extension, converter, destination, runner = execute) {
  await validateOfficeFile(file, extension);
  return convert(extension,converter,async input => {
    await link(file,input).catch(() => copyFile(file,input));
  }, async (pdfPath,input,output,options) => {
    await copyFile(pdfPath,destination);
    if(extension==='ppt'){
      let notes={notes:[],status:'unavailable'};
      try{
        await runner(converter,[`-env:UserInstallation=${pathToFileURL(options.profile).href}`,'--headless','--norestore','--convert-to','pptx:Impress MS PowerPoint 2007 XML','--outdir',output,input],options.runnerOptions);
        const python=process.env.PPT_NOTES_PYTHON||process.env.OCR_PYTHON||'python3';
        const {stdout}=await runner(python,[fileURLToPath(new URL('../scripts/pptx-notes.py',import.meta.url)),path.join(output,'presentation.pptx')],{timeout:15000,maxBuffer:4*1024*1024});
        const result=JSON.parse(stdout);if(Array.isArray(result.notes)&&['complete','partial','unavailable'].includes(result.status))notes=result;
      }catch{/* A notes failure must not prevent the presentation from opening. */}
      await writeFile(destination+'.notes.json',JSON.stringify(notes),{mode:0o600});
    }
    return destination;
  }, runner);
}

// Kept for already-open clients and the original converter contract.
export async function convertOfficeToPdf(bytes, extension, converter, runner = execute) {
  validateOfficeUpload(bytes, extension);
  return convert(extension,converter,input => writeFile(input,bytes),pdfPath=>readFile(pdfPath),runner);
}

async function convert(extension, converter, prepare, collect, runner) {
  if (!converter) fail('材料转换服务暂时不可用，请稍后重试，也可以先导出为 PDF 导入。', 503, 'converter_unavailable');
  const directory = await mkdtemp(path.join(tmpdir(), 'rehearsal-import-'));
  try {
    const profile = path.join(directory, 'profile'), output = path.join(directory, 'converted');
    await mkdir(path.join(profile, 'user'), { recursive: true });
    await mkdir(output);
    const xml = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    const fontConfig = path.join(directory, 'fonts.conf');
    // Fontconfig caches font discovery only, never document content. Reusing
    // this cache avoids rescanning all system fonts for every isolated import.
    // Keep the LibreOffice profile and document files isolated per conversion.
    let fontCache=path.join(directory,'cache');
    try {
      const shared=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../.local/font-cache');
      await mkdir(shared,{recursive:true,mode:0o700});fontCache=shared;
    } catch { /* Read-only installations retain the per-job fallback. */ }
    const fontDirs = process.platform === 'darwin'
      ? ['/System/Library/Fonts', '/Library/Fonts', path.resolve(path.dirname(converter), '../Resources/fonts')]
      : ['/usr/share/fonts', '/usr/local/share/fonts'];
    await writeFile(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>${fontDirs.map(dir => `<dir>${xml(dir)}</dir>`).join('')}<cachedir>${xml(fontCache)}</cachedir></fontconfig>`);
    await writeFile(path.join(profile, 'user/registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    const input = path.join(directory, `presentation.${extension}`);
    await prepare(input);
    try {
      await runner(converter, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--convert-to', 'pdf:impress_pdf_Export', '--outdir', output, input],
        { timeout: CONVERSION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, env: { ...process.env, FONTCONFIG_FILE: fontConfig, XDG_CACHE_HOME: path.join(directory, 'cache'), SAL_USE_VCLPLUGIN: 'svp' } });
    } catch (e) {
      fail(e.killed ? 'PPT 转换超过 5 分钟，可能包含过大的图片或视频。请压缩媒体，或导出为 PDF 后重试。' : 'PPT 转换失败。请确认能在 WPS / PowerPoint 正常打开，并重新另存为 PPTX 或 PDF。', 422, e.killed ? 'conversion_timeout' : 'conversion_failed');
    }
    const pdfPath = path.join(output, 'presentation.pdf');
    const info = await stat(pdfPath).catch(() => null);
    if (!info?.size) fail('未能读取这份 PPT，可能有密码保护、文件损坏或格式不兼容。请在 WPS / PowerPoint 中另存为 PPTX 或 PDF 后重试。', 422, 'conversion_no_output');
    if (info.size > MAX_PREVIEW_BYTES) fail(`转换后的 PDF 超过 ${MAX_DECK_MB} MB，请压缩图片后再导入。`, 422, 'preview_too_large');
    const handle = await open(pdfPath,'r');
    try { const head=Buffer.alloc(5); await handle.read(head,0,5,0); if(head.toString()!=='%PDF-')fail('生成的预览无法读取，请导出为 PDF 后重试。',422,'invalid_preview'); }
    finally { await handle.close(); }
    return await collect(pdfPath,input,output,{profile,runnerOptions:{timeout:CONVERSION_TIMEOUT_MS,killSignal:'SIGKILL',maxBuffer:128*1024,env:{...process.env,FONTCONFIG_FILE:fontConfig,XDG_CACHE_HOME:path.join(directory,'cache'),SAL_USE_VCLPLUGIN:'svp'}}});
  } finally { await rm(directory, { recursive: true, force: true }); }
}
