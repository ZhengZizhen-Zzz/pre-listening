// Build a small, valid PPTX by copying compressed ZIP entries. Large media on
// later slides is never read, decompressed, or uploaded for the first preview.
const encoder=new TextEncoder(),decoder=new TextDecoder(),MAX_XML=4*1024*1024;
const relPath=name=>{const i=name.lastIndexOf('/');return `${name.slice(0,i+1)}_rels/${name.slice(i+1)}.rels`;};
const children=(doc,name)=>[...doc.getElementsByTagNameNS('*',name)];
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function targetPath(source,target){
  const segments=(target.startsWith('/')?target.slice(1):source.slice(0,source.lastIndexOf('/')+1)+target).split('/'),out=[];
  for(const part of segments){if(part==='..'){if(!out.length)throw Error('Invalid package path');out.pop();}else if(part&&part!=='.')out.push(decodeURIComponent(part));}
  return out.join('/');
}
export async function readZipDirectory(file){
  const tail=new DataView(await file.slice(Math.max(0,file.size-65557)).arrayBuffer());let end=-1;
  for(let i=tail.byteLength-22;i>=0;i--)if(tail.getUint32(i,true)===0x06054b50&&i+22+tail.getUint16(i+20,true)===tail.byteLength){end=i;break;}
  if(end<0||tail.getUint16(end+4,true)||tail.getUint16(end+6,true))throw Error('Unsupported ZIP');
  const count=tail.getUint16(end+10,true),size=tail.getUint32(end+12,true),offset=tail.getUint32(end+16,true);
  if(count===65535||count!==tail.getUint16(end+8,true)||size>MAX_XML||offset+size>file.size-22)throw Error('Unsupported ZIP directory');
  const dir=new DataView(await file.slice(offset,offset+size).arrayBuffer()),entries=new Map();let at=0;
  for(let i=0;i<count;i++){
    if(at+46>dir.byteLength||dir.getUint32(at,true)!==0x02014b50)throw Error('Invalid ZIP entry');
    const length=dir.getUint16(at+28,true),next=at+46+length+dir.getUint16(at+30,true)+dir.getUint16(at+32,true);
    if(next>dir.byteLength)throw Error('Invalid ZIP entry');
    const name=decoder.decode(new Uint8Array(dir.buffer,at+46,length));
    if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||entries.has(name))throw Error('Invalid ZIP path');
    const entry={name,flags:dir.getUint16(at+8,true),method:dir.getUint16(at+10,true),crc:dir.getUint32(at+16,true),compressed:dir.getUint32(at+20,true),plain:dir.getUint32(at+24,true),offset:dir.getUint32(at+42,true)};
    if(entry.flags&1||![0,8].includes(entry.method)||entry.offset+30>offset)throw Error('Unsupported ZIP entry');
    entries.set(name,entry);at=next;
  }
  async function compressed(entry){
    const header=new DataView(await file.slice(entry.offset,entry.offset+30).arrayBuffer());
    if(header.getUint32(0,true)!==0x04034b50)throw Error('Invalid ZIP header');
    const start=entry.offset+30+header.getUint16(26,true)+header.getUint16(28,true);
    if(start+entry.compressed>offset)throw Error('Invalid ZIP data');
    return file.slice(start,start+entry.compressed);
  }
  async function bytes(name,limit=MAX_XML){
    const entry=entries.get(name);if(!entry||entry.plain>limit||entry.compressed>limit)throw Error('Invalid XML part');
    let stream=(await compressed(entry)).stream();if(entry.method===8)stream=stream.pipeThrough(new DecompressionStream('deflate-raw'));
    const reader=stream.getReader(),parts=[];let length=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw Error('XML limit');}parts.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(length);let i=0;for(const part of parts){bytes.set(part,i);i+=part.length;}
    if(length!==entry.plain||crc32(bytes)!==entry.crc)throw Error('Invalid XML checksum');
    return bytes;
  }
  const text=async name=>decoder.decode(await bytes(name));
  return {entries,compressed,text,bytes};
}
async function compactImage(zip,name,signal,maxDimension=1600){
  const entry=zip.entries.get(name);
  if(!/\.(png|jpe?g)$/i.test(name)||entry.plain<256*1024||entry.plain>64*1024*1024)return null;
  let bitmap;
  try{
    signal?.throwIfAborted();
    let data=await zip.compressed(entry);
    if(entry.method===8){
      const reader=data.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks=[];let size=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024*1024){await reader.cancel();return null;}chunks.push(value);}}finally{reader.releaseLock();}
      if(size!==entry.plain)return null;data=new Blob(chunks);
    }
    bitmap=await createImageBitmap(data);signal?.throwIfAborted();
    const scale=Math.min(1,maxDimension/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    // Preserve transparent backgrounds rather than flattening logos to white.
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let alpha=false;
    for(let i=3;i<pixels.length;i+=4)if(pixels[i]!==255){alpha=true;break;}
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,alpha?'image/png':'image/jpeg',maxDimension>1600?.88:.82));
    return blob&&blob.size<entry.compressed*.85?blob:null;
  }catch{signal?.throwIfAborted();return null;}finally{bitmap?.close();}
}
async function packageParts(zip,selected,modified){
  const parts=[],central=[];let offset=0;
  for(const name of selected){
    const entry=zip.entries.get(name),change=modified.get(name),bytes=change instanceof Blob?new Uint8Array(await change.arrayBuffer()):modified.has(name)?encoder.encode(change):null;
    const data=bytes?new Blob([bytes]):await zip.compressed(entry),method=bytes?0:entry.method,plain=bytes?bytes.length:entry.plain,crc=bytes?crc32(bytes):entry.crc;
    const filename=encoder.encode(name),header=new Uint8Array(30+filename.length),h=new DataView(header.buffer);
    h.setUint32(0,0x04034b50,true);h.setUint16(4,20,true);h.setUint16(6,0x800,true);h.setUint16(8,method,true);h.setUint32(14,crc,true);h.setUint32(18,data.size,true);h.setUint32(22,plain,true);h.setUint16(26,filename.length,true);header.set(filename,30);
    const record=new Uint8Array(46+filename.length),r=new DataView(record.buffer);
    r.setUint32(0,0x02014b50,true);r.setUint16(4,20,true);r.setUint16(6,20,true);r.setUint16(8,0x800,true);r.setUint16(10,method,true);r.setUint32(16,crc,true);r.setUint32(20,data.size,true);r.setUint32(24,plain,true);r.setUint16(28,filename.length,true);r.setUint32(42,offset,true);record.set(filename,46);
    parts.push(header,data);central.push(record);offset+=header.length+data.size;
  }
  const end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,central.length,true);e.setUint16(10,central.length,true);e.setUint32(12,central.reduce((n,x)=>n+x.length,0),true);e.setUint32(16,offset,true);
  return new Blob([...parts,...central,end],{type:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});
}
async function preparePptx(file,{count=2,signal,full=false}={}){
  try{
    signal?.throwIfAborted();
    const zip=await readZipDirectory(file),parser=new DOMParser(),serializer=new XMLSerializer();
    const parse=text=>{const doc=parser.parseFromString(text,'application/xml');if(children(doc,'parsererror').length)throw Error('Invalid package XML');return doc;};
    const presentation='ppt/presentation.xml',doc=parse(await zip.text(presentation)),ids=children(doc,'sldId');
    const totalPages=ids.length;if(!totalPages||totalPages>60||!full&&totalPages<=count)return null;
    if(full)count=totalPages;
    const relations=parse(await zip.text(relPath(presentation))),selectedIds=new Set(ids.slice(0,count).map(node=>[...node.attributes].find(a=>a.localName==='id'&&a.namespaceURI?.includes('relationships'))?.value));
    if(selectedIds.has(undefined))return null;
    const selectedSlides=new Set(children(relations,'Relationship').filter(r=>selectedIds.has(r.getAttribute('Id'))).map(r=>targetPath(presentation,r.getAttribute('Target'))));
    if(selectedSlides.size!==count)return null;
    ids.slice(count).forEach(node=>node.remove());
    if(!full){children(doc,'custShowLst').forEach(node=>node.remove());children(doc,'sectionLst').forEach(node=>node.remove());}
    const modified=new Map([[presentation,serializer.serializeToString(doc)]]),selected=new Set(),queue=[''];
    while(queue.length){
      signal?.throwIfAborted();
      const source=queue.shift();if(source&&selected.has(source))continue;
      if(source){if(!zip.entries.has(source))throw Error('Missing package dependency');selected.add(source);}
      const rels=source?relPath(source):'_rels/.rels';if(!zip.entries.has(rels))continue;
      const relDoc=parse(await zip.text(rels)),removed=[];
      for(const rel of children(relDoc,'Relationship')){
        if(rel.getAttribute('TargetMode')==='External')continue;
        const target=targetPath(source,rel.getAttribute('Target'));
        if(rel.getAttribute('Type').endsWith('/slide')&&!selectedSlides.has(target)){removed.push(rel.getAttribute('Id'));rel.remove();continue;}
        queue.push(target);
      }
      selected.add(rels);modified.set(rels,serializer.serializeToString(relDoc));
      if(removed.length&&source&&source!==presentation){
        const sourceDoc=parse(modified.get(source)||await zip.text(source));
        for(const name of ['hlinkClick','hlinkHover'])for(const node of children(sourceDoc,name))if([...node.attributes].some(a=>a.localName==='id'&&removed.includes(a.value)))node.remove();
        modified.set(source,serializer.serializeToString(sourceDoc));
      }
    }
    if(!selected.has(presentation)||[...selectedSlides].some(name=>!selected.has(name)))return null;
    const imageTypes=new Map();
    for(const name of selected){
      signal?.throwIfAborted();const image=await compactImage(zip,name,signal,full?2400:1600);
      if(image){modified.set(name,image);imageTypes.set(name,image.type);}
    }
    const types='[Content_Types].xml',typesDoc=parse(await zip.text(types));
    for(const [name,type]of imageTypes){
      let node=children(typesDoc,'Override').find(n=>n.getAttribute('PartName')==='/'+name);
      if(!node){node=typesDoc.createElementNS(typesDoc.documentElement.namespaceURI,'Override');node.setAttribute('PartName','/'+name);typesDoc.documentElement.append(node);}
      node.setAttribute('ContentType',type);
    }
    for(const node of children(typesDoc,'Override'))if(!selected.has(node.getAttribute('PartName').replace(/^\//,'')))node.remove();
    selected.add(types);modified.set(types,serializer.serializeToString(typesDoc));
    const blob=await packageParts(zip,selected,modified);signal?.throwIfAborted();
    // Shared full-deck media can make the fast path no smaller. Avoid sending
    // the same large payload twice in that case; normal import remains valid.
    if(!full&&blob.size>16*1024*1024||file.size>2*1024*1024&&blob.size>file.size*.85||full&&blob.size>=file.size)return null;
    return {blob,totalPages,previewPages:count};
  }catch(error){signal?.throwIfAborted();return null;}
}

export const firstPptxPages=(file,options={})=>preparePptx(file,options);
export const compactPptxPreview=(file,options={})=>preparePptx(file,{...options,full:true});
