import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const skipped=new Set(['.git','node_modules','.local','.venv','vendor','assets']);
const problems=[];let files=0;
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
 const full=path.join(dir,entry.name),rel=path.relative(root,full);
 if(entry.isDirectory()){if(!skipped.has(entry.name)||rel==='docs/assets')await walk(full);continue;}
 if(entry.name.startsWith('.env')&&entry.name!=='.env.example'){problems.push(`${rel}: private environment file`);continue;}
 if(/\.(?:wav|mp3|m4a|webm|pptx?|docx|pdf|log)$/i.test(entry.name)){problems.push(`${rel}: private or generated artifact`);continue;}
 files++;
 if(!/\.(?:mjs|json|md|html|css|py|yml|svg)$/.test(entry.name))continue;
 const text=await readFile(full,'utf8');
 if(/\b(?:sk-[a-zA-Z0-9]{24,}|gh[pousr]_[a-zA-Z0-9]{25,}|github_pat_[a-zA-Z0-9_]{30,})\b/.test(text))problems.push(`${rel}: credential-like string`);
 if(/\/Users\/apple\/|wxid_[a-zA-Z0-9_]+|https:\/\/[^\s"']+\.trycloudflare\.com/.test(text))problems.push(`${rel}: local identity or private trial URL`);
 if(entry.name.endsWith('.md'))for(const match of text.matchAll(/(?:\]\(|src=")([^\s)"#]+)(?:#[^\s)"]*)?[)"]/g)){
  const target=match[1];if(/^(?:https?:|mailto:)/.test(target))continue;
  try{await stat(path.resolve(path.dirname(full),target));}catch{problems.push(`${rel}: missing link ${target}`);}
 }
}}
await walk(root);
if(problems.length){console.error(problems.join('\n'));process.exitCode=1;}
else console.log(`Release check: ${files} files inspected; no detected credentials, private artifacts or broken relative documentation links.`);
