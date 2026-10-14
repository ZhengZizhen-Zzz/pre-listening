// PDF text layers are read first. Image-only pages use the local OCR service.
export async function readNativeText(pdf,pages,{progress=()=>{},onPage=()=>{},signal}={}) {
  const output=pages.map(page=>({...page}));
  for (const page of output) {
    signal?.throwIfAborted();progress(page.number,output.length);
    try {
      const content=await (await pdf.getPage(page.number)).getTextContent();
      signal?.throwIfAborted();
      const text=content.items.map(item=>item.str+(item.hasEOL?'\n':' ')).join('').trim();
      if(text)Object.assign(page,{text,textSource:'native'});
    } catch(error) {signal?.throwIfAborted();page.textReadFailed=true;}
    onPage({...page});
  }
  return output;
}
export async function readMissingText(pdf,pages,{recognize,progress=()=>{},onPage=()=>{},signal}){
  const output=pages.map(page=>({...page}));
  for(const page of output){
    signal?.throwIfAborted();
    if(page.text.trim())continue;
    progress(page.number,output.length);
    let canvas,renderTask;
    const abortRender=()=>renderTask?.cancel();
    try{
      const source=await pdf.getPage(page.number),base=source.getViewport({scale:1});
      const viewport=source.getViewport({scale:Math.min(2200/base.width,1650/base.height)});
      signal?.throwIfAborted();
      canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      renderTask=source.render({canvasContext:canvas.getContext('2d'),viewport});
      signal?.addEventListener('abort',abortRender,{once:true});
      await renderTask.promise;signal?.throwIfAborted();
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(!blob)throw new Error('页面无法读取');
      const result=await recognize(blob);
      signal?.throwIfAborted();
      Object.assign(page,{text:result.text || '',textSource:'ocr',ocrConfidence:result.confidence,ocrAttempted:true});
    }catch(error){signal?.throwIfAborted();page.ocrAttempted=true;page.ocrFailed=true;}
    finally{signal?.removeEventListener('abort',abortRender);if(canvas)canvas.width=canvas.height=0;}
    onPage({...page});
  }
  return output;
}
