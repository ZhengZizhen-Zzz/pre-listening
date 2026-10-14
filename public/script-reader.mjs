import {readZipDirectory} from './pptx-first-pages.mjs';
import {MAX_SCRIPT_CHARS} from './script-import-core.mjs';
const WORD_NS=new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main']);
export function docxText(xml){
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('这份 Word 文件格式异常，请另存为 DOCX 后再试。');
 const doc=new DOMParser().parseFromString(xml,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw Error('Word 文字无法读取。');
 const paragraphs=[...doc.getElementsByTagNameNS('*','p')].filter(p=>WORD_NS.has(p.namespaceURI));
 return paragraphs.map(p=>{
  let text='';const walk=n=>{if(WORD_NS.has(n.namespaceURI)){if(['del','instrText'].includes(n.localName)||n.localName==='p'&&n!==p)return;if(n.localName==='t'){text+=n.textContent;return;}if(['br','cr'].includes(n.localName)){text+='\n';return;}if(n.localName==='tab'){text+='\t';return;}}for(const c of n.childNodes||[])walk(c);};walk(p);return text;
 }).join('\n');
}
export function decodeScript(bytes){
 if(bytes[0]===255&&bytes[1]===254)return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/,'');
 if(bytes[0]===254&&bytes[1]===255)return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/,'');
 try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{return new TextDecoder('gb18030').decode(bytes);}
}
export async function readScriptFile(file,{openPdf,signal,onProgress=()=>{}}={}){
 const extension=file.name.split('.').at(-1).toLowerCase();
 if(!['docx','pdf','txt'].includes(extension))throw Error('请选择 DOCX、文字型 PDF 或 TXT；旧版 DOC 请先另存为 DOCX。');
 if(file.size>100*1024**2)throw Error('讲稿文件超过 100 MB，请移除大图片后再导入。');
 signal?.throwIfAborted();let text='';
 const check=value=>{if(value.length>MAX_SCRIPT_CHARS)throw Error('讲稿超过 12 万字，请拆成几份文件。');signal?.throwIfAborted();};
 if(extension==='docx'){
  const zip=await readZipDirectory(file);signal?.throwIfAborted();text=docxText(await zip.text('word/document.xml'));check(text);onProgress(text,1,1);
 }else if(extension==='txt'){
  if(file.size>2*1024**2)throw Error('TXT 文件过大，请拆成几份讲稿。');text=decodeScript(new Uint8Array(await file.arrayBuffer()));check(text);onProgress(text,1,1);
 }else{
  let pdf;const abort=()=>{void pdf?.destroy();};signal?.addEventListener('abort',abort,{once:true});
  try{
   pdf=await openPdf(file);signal?.throwIfAborted();if(pdf.numPages>120)throw Error('讲稿 PDF 超过 120 页，请拆分后导入。');
   let empty=0;
   for(let i=1;i<=pdf.numPages;i++){
    signal?.throwIfAborted();const page=await pdf.getPage(i),content=await page.getTextContent();
    const value=content.items.map(t=>t.str+(t.hasEOL?'\n':' ')).join('').trim();page.cleanup();
    if(!value)empty++;text+=(i>1?'\n\n':'')+value;check(text);onProgress(text,i,pdf.numPages);
   }
   if(empty)throw Error(`这份 PDF 有 ${empty} 页没有文字层，无法完整提取。请改用 Word、TXT 或粘贴完整讲稿。`);
  }finally{signal?.removeEventListener('abort',abort);await pdf?.destroy().catch(()=>{});}
 }
 check(text);if(!text.trim())throw Error('没有读取到讲稿文字，请换成文字型文件或直接粘贴。');return text;
}
