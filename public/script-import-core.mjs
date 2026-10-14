export const MAX_SCRIPT_CHARS=120000,MAX_SCRIPT_PARTS=800;
const marker=/^\s*(?:#{1,6}\s*)?(?:[【\[]\s*)?(?:第\s*([0-9０-９一二三四五六七八九十百零〇两]+)\s*页|(?:P(?:PT)?|PAGE|SLIDE)\s*([0-9]+))(?:\s*[】\]])?(?=\s|[:：.、-]|$)\s*[:：.、-]?\s*/i;
function pageNumber(value){
 value=value.replace(/[０-９]/g,c=>String(c.charCodeAt(0)-65296));if(/^\d+$/.test(value))return Number(value);
 const digit={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};let result=0,n=0;
 for(const c of value){if(c==='十'){result+=(n||1)*10;n=0;}else if(c==='百'){result+=(n||1)*100;n=0;}else n=digit[c]??0;}return result+n;
}
export function splitScript(raw,pageCount){
 if(typeof raw!=='string'||raw.length>MAX_SCRIPT_CHARS)throw Error('讲稿最多支持 12 万字，请拆成几次演练。');
 if(!raw.trim())throw Error('讲稿中没有可读取的文字。');
 const parts=[];let explicit=null;
 for(const line of raw.replace(/\r\n?/g,'\n').split('\n')){
  if(!line.trim())continue;
  const match=line.match(marker);if(match)explicit=pageNumber(match[1]||match[2]);
  const text=line.trim();
  // Split long paragraphs only at real sentence boundaries; never invent text.
  const sentences=text.match(/[^。！？.!?]+[。！？.!?]*|[。！？.!?]+/g)||[text];let chunk='';
  const add=()=>{if(!chunk)return;const valid=explicit!==null&&explicit>=1&&explicit<=pageCount;parts.push({id:`p${parts.length+1}`,text:chunk,page:valid?explicit:0,link:valid?'explicit':'unassigned',...(explicit!==null?{markedPage:explicit}:{})});chunk='';};
  for(const sentence of sentences){if(chunk.length+sentence.length>650)add();chunk+=sentence;}add();
 }
 if(parts.length>MAX_SCRIPT_PARTS)throw Error('讲稿分段过多，请拆成几份文件。');
 return parts;
}
const normalize=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
function tokens(s){
 const text=normalize(s),out=new Set();
 for(const word of s.toLowerCase().match(/[a-z][a-z0-9]{3,}/g)||[])out.add(word);
 for(let i=0;i<text.length-2;i++)out.add(text.slice(i,i+3));return out;
}
export function associateScript(parts,pages,{onlyUnassigned=false}={}){
 const indexes=pages.map(p=>({page:p.number,tokens:tokens((p.text||'').slice(0,12000)),title:normalize((p.text||'').split('\n')[0].slice(0,80))}));
 const frequency=new Map();for(const p of indexes)for(const t of p.tokens)frequency.set(t,(frequency.get(t)||0)+1);
 return parts.map(part=>{
  if(part.link==='manual'||part.link==='explicit'||part.markedPage!==undefined||onlyUnassigned&&part.page)return {...part};
  const content=normalize(part.text),terms=tokens(part.text),scores=indexes.map(p=>{
   let shared=0,weight=0;for(const t of terms)if(p.tokens.has(t)){shared++;weight+=1/(frequency.get(t)||1);}
   const title=p.title.length>=4&&p.title.length<=60&&content.includes(p.title);
   return {page:p.page,score:weight/(Math.sqrt(Math.max(1,terms.size)))+(title?5:0),shared,title};
  }).sort((a,b)=>b.score-a.score);
  const first=scores[0],second=scores[1];
  const reliable=first&&(first.title||first.shared>=4&&first.score>=1.1)&&(!second||first.score-second.score>=.65&&first.score>=second.score*1.35);
  return {...part,page:reliable?first.page:0,link:reliable?'suggested':'unassigned'};
 });
}
export function cleanImportedScript(input,pageCount,{allowAsset=false}={}){
 if(!input||typeof input.originalText!=='string'||!input.originalText.trim()||input.originalText.length>MAX_SCRIPT_CHARS||!Array.isArray(input.parts)||input.parts.length>MAX_SCRIPT_PARTS)return null;
 let total=0;const seen=new Set(),parts=[];
 for(const p of input.parts){
  if(!p||typeof p.id!=='string'||!/^p\d+$/.test(p.id)||seen.has(p.id)||typeof p.text!=='string'||!p.text.trim()||(total+=p.text.length)>MAX_SCRIPT_CHARS*2)return null;
  seen.add(p.id);const valid=Number.isInteger(p.page)&&p.page>=1&&p.page<=pageCount;
  parts.push({id:p.id,text:p.text,page:valid?p.page:0,link:valid&&['explicit','suggested','manual'].includes(p.link)?p.link:'unassigned',...(Number.isInteger(p.markedPage)?{markedPage:p.markedPage}:{})});
 }
 return {name:String(input.name||'导入讲稿').slice(0,200),originalText:input.originalText,parts,...(allowAsset&&typeof input.assetId==='string'?{assetId:input.assetId}:{})};
}
export function importedScriptSources(script,page){
 if(!script)return [];
 const mapped=script.parts.filter(p=>p.page===page),pending=script.parts.some(p=>!p.page),sources=[];
 if(mapped.length)sources.push({id:'imported',label:mapped.some(p=>p.link==='suggested')?'导入讲稿 · 建议页码':'导入讲稿',text:mapped.map(p=>p.text).join('\n\n')});
 if(pending||!mapped.length)sources.push({id:'imported-full',label:'导入讲稿 · 全文',text:script.parts.map(p=>p.text).join('\n\n')});
 sources.push({id:'imported-original',label:'导入原稿 · 全文',text:script.originalText});return sources;
}
