import {build} from 'esbuild';
import {readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'showcase-dist');
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
const result=await build({absWorkingDir:root,entryPoints:{app:'public/app.mjs',style:'public/showcase.css'},
  bundle:true,minify:true,format:'esm',target:'es2022',platform:'browser',external:['/vendor/*'],
  define:{__PRE_SHOWCASE__:'true'},outdir:out,entryNames:'[name]-[hash]',write:false,metafile:true});
for(const file of result.outputFiles)await writeFile(file.path,file.contents);
const entry=source=>'./'+path.basename(Object.entries(result.metafile.outputs).find(([,v])=>v.entryPoint===source)[0]);
const intro=`<section class="showcase-intro" aria-label="快速体验">
<div class="showcase-eyebrow"><span>交互示例 · 预设内容</span><a href="https://github.com/ZhengZizhen-Zzz/pre-listening">GitHub 项目 ↗</a></div>
<h2>讲了 7 分 05 秒，怎样把重点讲进 6 分钟？</h2>
<p>材料和发言已备好。找到冗长段落，采用一句改稿，再看看听众可能追问什么。</p>
<div class="showcase-steps"><button id="showcase-review">① 看用时与复盘</button><button id="showcase-rewrite">② 改稿并采用</button><button id="showcase-questions">③ 体验听众提问</button><button id="showcase-reset">重置示例</button></div></section>`;
let html=await readFile(path.join(root,'public/index.html'),'utf8');
html=html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-mode="showcase">')
 .replace('<title>Pre聆听大师 · 汇报演练</title>','<title>立即体验 · Pre聆听大师</title>')
 .replace(/<link rel="stylesheet" href="\/(?:style|review|focus)\.css">/g,'')
 .replace('</head>',`<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23324c79'/%3E%3Ctext x='16' y='23' font-size='23' fill='white' text-anchor='middle'%3EP%3C/text%3E%3C/svg%3E"><meta name="description" content="无需注册，直接体验 PPT 逐页复盘、改稿采用与模拟听众追问。"><link rel="stylesheet" href="${entry('public/showcase.css')}"><link rel="modulepreload" href="${entry('public/app.mjs')}"></head>`)
 .replace('src="/app.mjs"',`src="${entry('public/app.mjs')}"`)
 .replace('class="brand" href="/"','class="brand" href="./"')
 .replace('<main>','<main>'+intro)
 .replace('</main>','<footer class="showcase-footnote">示例材料、建议与点评均为预设内容，用于体验操作流程。真实录音、转写与 AI 分析可在<a href="https://github.com/ZhengZizhen-Zzz/pre-listening/blob/main/docs/SETUP.md">完整版</a>使用。<br><a href="https://github.com/ZhengZizhen-Zzz/pre-listening/blob/main/docs/AGENT-TRACE.md">查看真实模型的 Agent 决策记录 ↗</a></footer></main>');
if(!html.includes('data-mode="showcase"'))throw Error('Missing showcase mode');
await writeFile(path.join(out,'index.html'),html);
await writeFile(path.join(out,'.nojekyll'),'');
console.log(`Built static experience: ${result.outputFiles.length+1} files, ${Math.round((result.outputFiles.reduce((n,f)=>n+gzipSync(f.contents).length,0)+gzipSync(html).length)/1024)} KiB gzipped total. No model credentials or backend required.`);
