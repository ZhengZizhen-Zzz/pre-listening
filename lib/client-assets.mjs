import { build } from 'esbuild';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';

const zip = promisify(gzip), brotli = promisify(brotliCompress);
export async function buildClientAssets(root) {
  const result = await build({
    absWorkingDir:root, entryPoints:{app:'public/app.mjs',style:'public/entry.css'},
    bundle:true, minify:true, format:'esm', target:'es2022', platform:'browser',
    external:['/vendor/*'], outdir:'public/assets', entryNames:'[name]-[hash]',
    write:false, metafile:true, logLevel:'silent'
  });
  await mkdir(path.join(root,'public/assets'),{recursive:true});
  for (const file of result.outputFiles) {
    const temporary=`${file.path}.${randomUUID()}.tmp`;
    await writeFile(temporary,file.contents);await rename(temporary,file.path);
  }
  const entry = source => '/'+Object.entries(result.metafile.outputs).find(([,details])=>details.entryPoint===source)[0].replace(/^public\//,'');
  const script=entry('public/app.mjs'),style=entry('public/entry.css');
  const template=await readFile(path.join(root,'public/index.html'),'utf8');
  const html=template.replace(/<link rel="stylesheet" href="\/(?:style|review|focus)\.css">/g,'')
    .replace('</head>',`<link rel="stylesheet" href="${style}"><link rel="modulepreload" href="${script}"></head>`)
    .replace('src="/app.mjs"',`src="${script}"`);
  return {html:Buffer.from(html),script,style,inputs:Object.keys(result.metafile.inputs).length};
}

export async function prepareAsset(bytes,type,cacheControl) {
  const etag=`W/"${createHash('sha256').update(bytes).digest('base64url')}"`;
  const compressed = bytes.length>=1024 && /text|javascript|json|svg|wasm/.test(type);
  const [gz,br]=compressed ? await Promise.all([zip(bytes),brotli(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:4}})]) : [];
  return {bytes,gz,br,type,etag,cacheControl};
}
export function sendAsset(req,res,asset) {
  const supported = new Map(String(req.headers['accept-encoding']||'').split(',').map(part=>{
    const [name,...params]=part.trim().split(';');const quality=params.find(p=>p.trim().startsWith('q='));
    return [name.trim(),quality ? Number(quality.trim().slice(2)) : 1];
  }));
  const quality = name => supported.get(name) ?? supported.get('*') ?? 0;
  const encoding=asset.br && quality('br')>0 && quality('br')>=quality('gzip') ? 'br' : asset.gz && quality('gzip')>0 ? 'gzip' : null;
  const bytes=encoding==='br'?asset.br:encoding==='gzip'?asset.gz:asset.bytes;
  const headers={'Content-Type':asset.type,'Cache-Control':asset.cacheControl,ETag:asset.etag,Vary:'Accept-Encoding',...(encoding?{'Content-Encoding':encoding}:{})};
  if (String(req.headers['if-none-match']||'').split(',').map(v=>v.trim()).some(v=>v===asset.etag||v==='*')) {res.writeHead(304,headers);return res.end();}
  res.writeHead(200,{...headers,'Content-Length':bytes.length});
  res.end(req.method==='HEAD'?undefined:bytes);
}
