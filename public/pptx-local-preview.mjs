import {readZipDirectory} from './pptx-first-pages.mjs';
const all=(n,name)=>[...(n?.getElementsByTagNameNS('*',name)||[])];
const child=(n,name)=>[...(n?.children||[])].find(x=>x.localName===name);
const first=(n,name)=>all(n,name)[0];
const attr=(n,name)=>n?.getAttribute(name);
const number=(n,name,fallback=0)=>Number(attr(n,name)||fallback);
const xml=text=>{if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Unsafe XML');const d=new DOMParser().parseFromString(text,'application/xml');if(first(d,'parsererror'))throw Error('Invalid XML');return d;};
function path(source,target){const out=[];for(const p of (target.startsWith('/')?target.slice(1):source.slice(0,source.lastIndexOf('/')+1)+target).split('/')){if(p==='..'){if(!out.length)throw Error('Invalid path');out.pop();}else if(p&&p!=='.')out.push(decodeURIComponent(p));}return out.join('/');}
const relfile=name=>name.slice(0,name.lastIndexOf('/')+1)+'_rels/'+name.slice(name.lastIndexOf('/')+1)+'.rels';
// Reads the actual first slide XML, not the package thumbnail (which can be stale).
// Only a fast visual preview: full conversion remains authoritative for recording.
export async function localPptxPreview(file,{signal,onUnsupported=()=>{}}={}){
 let canvas;const bitmaps=[];
 try{
  const zip=await readZipDirectory(file);signal?.throwIfAborted();
  const read=async name=>xml(await zip.text(name));
  const rels=async source=>zip.entries.has(relfile(source))?all(await read(relfile(source)),'Relationship'):[];
  const related=async(source,kind)=>{const r=(await rels(source)).find(r=>attr(r,'Type')?.endsWith('/'+kind)&&attr(r,'TargetMode')!=='External');return r?path(source,attr(r,'Target')):null;};
  const presentation=await read('ppt/presentation.xml'),ids=all(presentation,'sldId'),size=first(presentation,'sldSz');
  if(!ids.length||ids.length>60)return null;
  const id=[...ids[0].attributes].find(a=>a.localName==='id'&&a.namespaceURI?.includes('relationships'))?.value;
  const r=(await rels('ppt/presentation.xml')).find(r=>attr(r,'Id')===id&&attr(r,'TargetMode')!=='External');if(!r)return null;
  const slideName=path('ppt/presentation.xml',attr(r,'Target')),slide=await read(slideName);
  const layoutName=await related(slideName,'slideLayout'),layout=layoutName?await read(layoutName):null;
  const masterName=layoutName?await related(layoutName,'slideMaster'):null,master=masterName?await read(masterName):null;
  const themeName=masterName?await related(masterName,'theme'):null,theme=themeName?await read(themeName):null;
  const palette={dk1:'000000',lt1:'ffffff',dk2:'1f2937',lt2:'eeeeee',accent1:'4472c4',accent2:'ed7d31'};
  for(const n of first(theme,'clrScheme')?.children||[]){const c=n.children[0];if(c)palette[n.localName]=attr(c,'lastClr')||attr(c,'val');}
  const aliases={tx1:'dk1',tx2:'dk2',bg1:'lt1',bg2:'lt2',...(Object.fromEntries([...(first(master,'clrMap')?.attributes||[])].map(a=>[a.name,a.value])))};
  function color(fill,fallback){const c=fill?.children?.[0];if(!c)return fallback;let value=c.localName==='srgbClr'?attr(c,'val'):c.localName==='sysClr'?attr(c,'lastClr'):c.localName==='schemeClr'?palette[aliases[attr(c,'val')]||attr(c,'val')]:null;if(!/^[a-f\d]{6}$/i.test(value||''))return fallback;let rgb=[0,2,4].map(i=>parseInt(value.slice(i,i+2),16));for(const n of c.children){const v=number(n,'val')/100000;if(n.localName==='tint')rgb=rgb.map(x=>x+(255-x)*v);if(n.localName==='shade'||n.localName==='lumMod')rgb=rgb.map(x=>x*v);if(n.localName==='lumOff')rgb=rgb.map(x=>x+255*v);}return 'rgb('+rgb.map(x=>Math.max(0,Math.min(255,Math.round(x)))).join(',')+')';}
  const w=number(size,'cx'),h=number(size,'cy');if(w<=0||h<=0||w/h<.3||w/h>4)return null;
  const scale=Math.min(1400/w,900/h);canvas=document.createElement('canvas');canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);const ctx=canvas.getContext('2d');if(!ctx)return null;
  const bg=first(slide,'bg')||first(layout,'bg')||first(master,'bg');
  let backgroundFill=first(bg,'solidFill');
  const bgRef=first(bg,'bgRef');if(bgRef){const fill=first(theme,'bgFillStyleLst')?.children[number(bgRef,'idx')-1001];if(fill?.localName!=='solidFill')return null;backgroundFill=first(fill,'schemeClr')?.getAttribute('val')==='phClr'?bgRef:fill;}
  if(bg&&(first(bg,'blipFill')||first(bg,'gradFill')))return null;
  ctx.fillStyle=color(backgroundFill,'#ffffff');ctx.fillRect(0,0,canvas.width,canvas.height);
  const placeholderMatch=sp=>{const ph=first(sp,'ph');if(!ph)return null;const idx=attr(ph,'idx')||'0',type=attr(ph,'type')||'body';return all(layout,'sp').find(n=>{const p=first(n,'ph');return p&&(attr(p,'idx')||'0')===idx&&(attr(p,'type')||'body')===type;})||all(layout,'sp').find(n=>(attr(first(n,'ph'),'type')||'body')===type);};
  const image=async(name,fill,box)=>{const blip=first(fill,'blip'),embed=[...(blip?.attributes||[])].find(a=>a.localName==='embed')?.value;const rel=(await rels(name)).find(r=>attr(r,'Id')===embed&&attr(r,'TargetMode')!=='External');if(!rel)throw Error('Unsupported image');const target=path(name,attr(rel,'Target'));if(!/\.(png|jpe?g|gif|webp)$/i.test(target))throw Error('Unsupported image');const data=await zip.bytes(target,24*1024*1024);signal?.throwIfAborted();const bitmap=await createImageBitmap(new Blob([data]));bitmaps.push(bitmap);const crop=first(fill,'srcRect'),l=number(crop,'l')/100000,t=number(crop,'t')/100000,rr=number(crop,'r')/100000,b=number(crop,'b')/100000;ctx.drawImage(bitmap,l*bitmap.width,t*bitmap.height,(1-l-rr)*bitmap.width,(1-t-b)*bitmap.height,box.x,box.y,box.w,box.h);};
  const drawText=(sp,inherited,box)=>{
   const body=child(sp,'txBody');if(!body)return;const bp=child(body,'bodyPr'),anchor=attr(bp,'anchor')||'t';const inset={l:number(bp,'lIns',91440)*scale,r:number(bp,'rIns',91440)*scale,t:number(bp,'tIns',45720)*scale,b:number(bp,'bIns',45720)*scale};
   const title=['title','ctrTitle'].includes(attr(first(sp,'ph'),'type'));
   const defaults=first(inherited,'defRPr')||first(first(master,title?'titleStyle':'bodyStyle'),'defRPr');const paragraphs=[];
   for(const p of body.children){if(p.localName!=='p')continue;const props=child(p,'pPr'),base=child(props,'defRPr')||defaults,fragments=[];
    for(const run of p.children){if(run.localName==='br'){fragments.push({break:true});continue;}if(!['r','fld'].includes(run.localName))continue;const text=child(run,'t')?.textContent||'',rp=child(run,'rPr')||base;const size=number(rp,'sz',number(base,'sz',title?3200:2000))/100*12700*scale,bold=attr(rp,'b')==='1'||attr(base,'b')==='1',italic=attr(rp,'i')==='1';let font=attr(first(rp,'ea'),'typeface')||attr(first(rp,'latin'),'typeface')||'Arial';if(font.startsWith('+'))font='Arial';font=font.replace(/["\\\r\n]/g,'');const fill=color(child(rp,'solidFill'),color(child(base,'solidFill'),'#202b33'));fragments.push({text,size,font,bold,italic,fill});}
    if(!fragments.length)continue;const lines=[];let line=[],width=0,height=0;const push=()=>{lines.push({items:line,width,height:height||20});line=[];width=0;height=0;};
    for(const f of fragments){if(f.break){push();continue;}ctx.font=`${f.italic?'italic ':''}${f.bold?'bold ':''}${f.size}px "${f.font}", Arial, sans-serif`;for(const char of f.text){const cw=ctx.measureText(char).width;if(width+cw>box.w-inset.l-inset.r&&line.length)push();line.push({...f,char,x:width});width+=cw;height=Math.max(height,f.size*1.2);}}
    if(line.length)push();paragraphs.push({lines,align:attr(props,'algn')||attr(first(inherited,'pPr'),'algn')||'l'});
   }
   const height=paragraphs.reduce((n,p)=>n+p.lines.reduce((a,l)=>a+l.height,0),0);let y=box.y+inset.t+(anchor==='ctr'?Math.max(0,(box.h-inset.t-inset.b-height)/2):anchor==='b'?Math.max(0,box.h-inset.t-inset.b-height):0);
   ctx.save();ctx.beginPath();ctx.rect(box.x,box.y,box.w,box.h);ctx.clip();ctx.textBaseline='top';
   for(const p of paragraphs)for(const l of p.lines){const x=box.x+inset.l+(p.align==='ctr'?(box.w-inset.l-inset.r-l.width)/2:p.align==='r'?box.w-inset.l-inset.r-l.width:0);for(const c of l.items){ctx.font=`${c.italic?'italic ':''}${c.bold?'bold ':''}${c.size}px "${c.font}", Arial, sans-serif`;ctx.fillStyle=c.fill;ctx.fillText(c.char,x+c.x,y);}y+=l.height;}ctx.restore();
  };
  let count=0;
  const draw=async(doc,name,background=false)=>{const tree=doc.localName==='grpSp'?doc:first(doc,'spTree');for(const sp of tree?.children||[]){
   signal?.throwIfAborted();if(['nvGrpSpPr','grpSpPr','extLst'].includes(sp.localName))continue;if(background&&first(sp,'ph'))continue;
   if(sp.localName==='grpSp'){const xf=first(child(sp,'grpSpPr'),'xfrm'),off=child(xf,'off'),ext=child(xf,'ext'),chOff=child(xf,'chOff'),chExt=child(xf,'chExt');if(!number(chExt,'cx')||!number(chExt,'cy')||number(xf,'rot'))throw Error('Complex group');ctx.save();ctx.translate(number(off,'x')*scale,number(off,'y')*scale);ctx.scale(number(ext,'cx')/number(chExt,'cx'),number(ext,'cy')/number(chExt,'cy'));ctx.translate(-number(chOff,'x')*scale,-number(chOff,'y')*scale);await draw(sp,name,background);ctx.restore();continue;}
   if(!['sp','pic','cxnSp'].includes(sp.localName))throw Error('Complex first slide');
   const inherited=!background?placeholderMatch(sp):null,props=child(sp,'spPr'),xf=child(props,'xfrm')||first(inherited,'xfrm');if(!xf)throw Error('Missing geometry');
   const off=child(xf,'off'),ext=child(xf,'ext'),box={x:number(off,'x')*scale,y:number(off,'y')*scale,w:number(ext,'cx')*scale,h:number(ext,'cy')*scale};
   ctx.save();const rot=number(xf,'rot')/60000*Math.PI/180;if(rot){ctx.translate(box.x+box.w/2,box.y+box.h/2);ctx.rotate(rot);ctx.translate(-box.x-box.w/2,-box.y-box.h/2);}
   if(attr(xf,'flipH')==='1'||attr(xf,'flipV')==='1'){ctx.translate(box.x+box.w/2,box.y+box.h/2);ctx.scale(attr(xf,'flipH')==='1'?-1:1,attr(xf,'flipV')==='1'?-1:1);ctx.translate(-box.x-box.w/2,-box.y-box.h/2);}
   if(sp.localName==='pic')await image(name,child(sp,'blipFill'),box);
   else{
    if(first(props,'custGeom')||first(props,'gradFill')||first(props,'pattFill'))throw Error('Complex shape');
    const geometry=attr(child(props,'prstGeom'),'prst')||'rect';if(!['rect','roundRect','ellipse','line'].includes(geometry))throw Error('Complex shape');
    ctx.beginPath();if(geometry==='ellipse')ctx.ellipse(box.x+box.w/2,box.y+box.h/2,box.w/2,box.h/2,0,0,Math.PI*2);else if(geometry==='line'){ctx.moveTo(box.x,box.y);ctx.lineTo(box.x+box.w,box.y+box.h);}else if(geometry==='roundRect')ctx.roundRect(box.x,box.y,box.w,box.h,Math.min(box.w,box.h)*.12);else ctx.rect(box.x,box.y,box.w,box.h);
    const fill=child(props,'solidFill');if(fill){ctx.fillStyle=color(fill,'#ffffff');ctx.fill();}const ln=child(props,'ln');if(ln&&!child(ln,'noFill')){ctx.lineWidth=Math.max(1,number(ln,'w',12700)*scale);ctx.strokeStyle=color(child(ln,'solidFill'),'#888888');ctx.stroke();}
    if(child(props,'blipFill'))await image(name,child(props,'blipFill'),box);drawText(sp,inherited,box);
   }ctx.restore();count++;
  }};
  if(master&&attr(slide.documentElement,'showMasterSp')!=='0'&&attr(layout?.documentElement,'showMasterSp')!=='0')await draw(master,masterName,true);
  if(layout)await draw(layout,layoutName,true);await draw(slide,slideName);
  if(!count)return null;signal?.throwIfAborted();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));signal?.throwIfAborted();return blob?{blob,totalPages:ids.length,width:canvas.width,height:canvas.height}:null;
 }catch(error){onUnsupported(error.message);signal?.throwIfAborted();return null;}finally{for(const b of bitmaps)b.close();if(canvas){canvas.width=1;canvas.height=1;}}
}
