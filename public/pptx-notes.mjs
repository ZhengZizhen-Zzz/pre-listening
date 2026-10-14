import {readZipDirectory} from './pptx-first-pages.mjs';
const nodes=(doc,name)=>[...(doc.getElementsByTagNameNS?.('*',name)||[])];
const relPath=name=>{const i=name.lastIndexOf('/');return `${name.slice(0,i+1)}_rels/${name.slice(i+1)}.rels`;};
function targetPath(source,target){
  if(!target||/[\\?#]/.test(target))throw Error('Invalid notes relationship');
  const out=[];
  for(const part of (target.startsWith('/')?target.slice(1):source.slice(0,source.lastIndexOf('/')+1)+target).split('/')){
    const decoded=decodeURIComponent(part);
    if(decoded==='..'){if(!out.length)throw Error('Invalid notes path');out.pop();}
    else if(decoded&&decoded!=='.'){if(decoded.includes('/')||decoded.includes('\\'))throw Error('Invalid notes path');out.push(decoded);}
  }
  return out.join('/');
}
export function cleanOriginalNotes(input,pageCount=60){
  if(!Array.isArray(input))return [];
  const seen=new Set();let total=0;
  return input.filter(n=>{
    if(!Number.isInteger(n?.page)||n.page<1||n.page>pageCount||seen.has(n.page)||typeof n.text!=='string'||!n.text.trim()||n.text.length>100000||total+n.text.length>500000)return false;
    seen.add(n.page);total+=n.text.length;return true;
  }).map(n=>({page:n.page,text:n.text}));
}
export function notesText(doc){
  const paragraphs=[];
  for(const shape of nodes(doc,'sp')){
    const ph=nodes(shape,'ph')[0],type=ph?.getAttribute('type');
    if(type!=='body')continue; // Speaker text lives in the notes body, not notes-page decorations.
    for(const body of nodes(shape,'txBody'))for(const p of nodes(body,'p')){
      const text=nodes(p,'t').length?[...p.childNodes].map(child=>child.localName==='br'?'\n':nodes(child,'t').map(t=>t.textContent).join('')).join(''):'';
      paragraphs.push(text);
    }
  }
  return paragraphs.join('\n').trim();
}
export async function readPptxNotes(file,{signal}={}){
  try{
    const zip=await readZipDirectory(file),parser=new DOMParser();
    const parse=async name=>{signal?.throwIfAborted();const text=await zip.text(name);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Unsupported XML');const doc=parser.parseFromString(text,'application/xml');if(nodes(doc,'parsererror').length)throw Error('Invalid XML');return doc;};
    const presentation='ppt/presentation.xml',doc=await parse(presentation),relations=nodes(await parse(relPath(presentation)),'Relationship');
    const slides=nodes(doc,'sldId');if(!slides.length||slides.length>60)throw Error('Invalid page count');
    const notes=[];let failed=false,total=0;
    for(let i=0;i<slides.length;i++){
      signal?.throwIfAborted();
      try{
        const id=[...slides[i].attributes].find(a=>a.localName==='id'&&a.namespaceURI?.includes('relationships'))?.value;
        const rel=relations.find(r=>r.getAttribute('Id')===id&&r.getAttribute('Type').endsWith('/slide')&&r.getAttribute('TargetMode')!=='External');
        if(!rel)throw Error('Missing slide relationship');
        const slide=targetPath(presentation,rel.getAttribute('Target')),path=relPath(slide);
        if(!zip.entries.has(path))continue;
        const note=nodes(await parse(path),'Relationship').find(r=>r.getAttribute('Type').endsWith('/notesSlide')&&r.getAttribute('TargetMode')!=='External');
        if(!note)continue;
        const text=notesText(await parse(targetPath(slide,note.getAttribute('Target'))));
        if(text.length>100000||total+text.length>500000)throw Error('Notes limit');
        if(text){notes.push({page:i+1,text});total+=text.length;}
      }catch(error){signal?.throwIfAborted();failed=true;}
    }
    return {notes,status:failed?'partial':'complete'};
  }catch(error){signal?.throwIfAborted();return {notes:[],status:'unavailable'};}
}
