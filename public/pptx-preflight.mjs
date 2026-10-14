// Read only the ZIP directory and presentation.xml. Large photos and videos
// never need to enter memory just to discover that a deck exceeds the limit.
const MAX_DIRECTORY=4*1024*1024,MAX_XML=1024*1024;
export function countPresentationSlides(xml){
  const clean=xml.replace(/<!--[\s\S]*?-->/g,'');
  const namespace=clean.match(/xmlns(?::([\w.-]+))?=["'](?:http:\/\/schemas\.openxmlformats\.org\/presentationml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/presentationml\/main)["']/);
  if(!namespace)return null;
  const prefix=namespace[1]?namespace[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+':':'';
  const list=clean.match(new RegExp(`<${prefix}sldIdLst\\b[^>]*>([\\s\\S]*?)<\\/${prefix}sldIdLst\\s*>`));
  if(!list)return null;
  const count=(list[1].match(new RegExp(`<${prefix}sldId(?=\\s|/|>)`,'g'))||[]).length;
  return count>0?count:null;
}
export async function readPptxPageCount(file){
  try{
    if(file.size<22)return null;
    const tail=new DataView(await file.slice(Math.max(0,file.size-65557)).arrayBuffer());
    let end=-1;
    for(let at=tail.byteLength-22;at>=0;at--)if(tail.getUint32(at,true)===0x06054b50&&at+22+tail.getUint16(at+20,true)===tail.byteLength){end=at;break;}
    if(end<0||tail.getUint16(end+4,true)||tail.getUint16(end+6,true))return null;
    const entries=tail.getUint16(end+10,true),size=tail.getUint32(end+12,true),offset=tail.getUint32(end+16,true);
    if(entries===65535||entries!==tail.getUint16(end+8,true)||!size||size>MAX_DIRECTORY||offset+size>file.size-22)return null;
    const directory=new DataView(await file.slice(offset,offset+size).arrayBuffer()),decoder=new TextDecoder();
    let found;
    for(let at=0,i=0;i<entries;i++){
      if(at+46>directory.byteLength||directory.getUint32(at,true)!==0x02014b50)return null;
      const nameSize=directory.getUint16(at+28,true),extra=directory.getUint16(at+30,true),comment=directory.getUint16(at+32,true),next=at+46+nameSize+extra+comment;
      if(next>directory.byteLength)return null;
      const name=decoder.decode(new Uint8Array(directory.buffer,at+46,nameSize));
      if(name==='ppt/presentation.xml'){
        if(found)return null;
        found={flags:directory.getUint16(at+8,true),method:directory.getUint16(at+10,true),compressed:directory.getUint32(at+20,true),plain:directory.getUint32(at+24,true),offset:directory.getUint32(at+42,true)};
      }
      at=next;
    }
    if(!found||found.flags&1||![0,8].includes(found.method)||found.compressed>MAX_XML||found.plain>MAX_XML||found.offset+30>offset)return null;
    const head=new DataView(await file.slice(found.offset,found.offset+30).arrayBuffer());
    if(head.getUint32(0,true)!==0x04034b50)return null;
    const start=found.offset+30+head.getUint16(26,true)+head.getUint16(28,true);
    if(start+found.compressed>offset)return null;
    let stream=file.slice(start,start+found.compressed).stream();
    if(found.method===8)stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader=stream.getReader(),parts=[];let length=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_XML){await reader.cancel();return null;}parts.push(value);}}
    finally{reader.releaseLock();}
    if(length!==found.plain)return null;
    const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
    return countPresentationSlides(decoder.decode(bytes));
  }catch{return null;} // Unsupported ZIP features still use the normal import path.
}
