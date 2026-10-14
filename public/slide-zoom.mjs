export function zoomGeometry({width,height,pageWidth,pageHeight,zoom=1}){
  if(![width,height,pageWidth,pageHeight].every(v=>Number.isFinite(v)&&v>0))return null;
  const level=Math.max(1,Math.min(3,Number(zoom)||1));
  const fit=Math.min(Math.max(1,width-32)/pageWidth,Math.max(1,height-32)/pageHeight);
  const imageWidth=pageWidth*fit*level,imageHeight=pageHeight*fit*level;
  return {zoom:level,imageWidth,imageHeight,sheetWidth:Math.max(width,imageWidth+32),sheetHeight:Math.max(height,imageHeight+32)};
}

export function createSlideZoom({dialog,viewport,sheet,image,range,label,minus,plus,fit}){
  let zoom=1,geometry=null,drag=null;
  function layout(center=true){
    const next=zoomGeometry({width:viewport.clientWidth,height:viewport.clientHeight,pageWidth:image.naturalWidth,pageHeight:image.naturalHeight,zoom});
    if(!next)return;
    const x=geometry?(viewport.scrollLeft+viewport.clientWidth/2)/geometry.sheetWidth:.5;
    const y=geometry?(viewport.scrollTop+viewport.clientHeight/2)/geometry.sheetHeight:.5;
    sheet.style.width=`${next.sheetWidth}px`;sheet.style.height=`${next.sheetHeight}px`;
    image.style.width=`${next.imageWidth}px`;image.style.height=`${next.imageHeight}px`;
    range.value=String(Math.round(zoom*100));label.textContent=`${Math.round(zoom*100)}%`;
    minus.disabled=zoom<=1;plus.disabled=zoom>=3;
    viewport.classList.toggle('zoomed',zoom>1);
    if(center){viewport.scrollLeft=x*next.sheetWidth-viewport.clientWidth/2;viewport.scrollTop=y*next.sheetHeight-viewport.clientHeight/2;}
    geometry=next;
  }
  function setZoom(value){zoom=Math.max(1,Math.min(3,value));layout();}
  function reset(){zoom=1;geometry=null;layout(false);viewport.scrollTop=0;viewport.scrollLeft=0;}
  minus.addEventListener('click',()=>setZoom(zoom-.25));plus.addEventListener('click',()=>setZoom(zoom+.25));fit.addEventListener('click',reset);
  range.addEventListener('input',()=>setZoom(Number(range.value)/100));
  dialog.addEventListener('keydown',event=>{
    if(event.ctrlKey||event.metaKey||event.altKey||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;
    if(['+','=','-','0'].includes(event.key)){event.preventDefault();event.stopPropagation();event.key==='0'?reset():setZoom(zoom+(event.key==='-'?-.25:.25));}
  });
  image.addEventListener('load',()=>{geometry=null;layout(false);viewport.scrollTop=0;viewport.scrollLeft=0;});
  image.addEventListener('dragstart',event=>event.preventDefault());
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.pointerType==='touch'||zoom<=1||image.hidden)return;
    event.preventDefault();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove',event=>{if(drag?.id!==event.pointerId)return;viewport.scrollLeft=drag.left+drag.x-event.clientX;viewport.scrollTop=drag.top+drag.y-event.clientY;});
  const stop=()=>{drag=null;viewport.classList.remove('dragging');};
  for(const event of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(event,stop);
  const observer=new ResizeObserver(()=>{if(dialog.open)layout();});observer.observe(viewport);
  return {reset,refresh:()=>layout()};
}
