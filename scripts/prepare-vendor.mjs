import {cp, mkdir, copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const source=dirname(require.resolve('pdfjs-dist/package.json'));
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=resolve(root,'public/vendor/pdfjs');
const version=require('pdfjs-dist/package.json').version;
await mkdir(resolve(target,`legacy-${version}`),{recursive:true});
for(const dir of ['cmaps','standard_fonts','wasm'])await cp(resolve(source,dir),resolve(target,dir),{recursive:true});
for(const file of ['pdf.min.mjs','pdf.worker.min.mjs']){
 await copyFile(resolve(source,'build',file),resolve(target,file));
 await copyFile(resolve(source,'legacy/build',file),resolve(target,`legacy-${version}`,file));
}
await copyFile(resolve(source,'LICENSE'),resolve(target,'LICENSE'));
console.log(`Prepared PDF.js ${version} with its fonts, CMaps, WASM and license notices.`);
