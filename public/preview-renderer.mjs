export const PDF_PREVIEW_VERSION = '5.6.205';
export const PDF_PREVIEW_BASE = `/vendor/pdfjs/legacy-${PDF_PREVIEW_VERSION}`;

export function previewFailure(error) {
  const detail=String(error?.message||'');
  if(/toBase64|fromBase64|sumPrecise|withResolvers|Promise\.try|transferToFixedLength|is not a function|not supported/i.test(detail))
    return {code:'browser_unsupported',reason:'missing_browser_api',message:'这个浏览器暂时无法显示本页。请复制链接到新版 Chrome 或 Edge 打开。'};
  if(error?.name==='RangeError'||/memory|allocation|canvas.*(?:size|dimension)|out of bounds/i.test(detail))
    return {code:'render_memory',reason:'canvas_allocation',message:'本页图片较大，预览未能显示。可以先重试，或关闭其他占用内存的页面后再试。'};
  if(/same canvas.*multiple render/i.test(detail))
    return {code:'render_conflict',reason:'canvas_in_use',message:'本页显示被打断了，请重试。'};
  if(/fetch|network|load.*(?:font|resource|wasm)|worker.*(?:destroy|terminat)/i.test(detail))
    return {code:'render_resource',reason:'resource_unavailable',message:'本页显示所需的资源未能加载，请检查网络后重试。'};
  return {code:'preview_failed',reason:'render_failed',message:'文件已经读到，但这一页暂时未能显示。请先重试；仍失败时，可从 WPS 或 PowerPoint 导出 PDF 后再导入。'};
}

export function previewGeometry(base, width, height, pixelRatio=1) {
  if(![base.width,base.height].every(n=>Number.isFinite(n)&&n>0)||![width,height].every(n=>Number.isFinite(n)&&n>24))throw new Error('Invalid canvas dimensions');
  const cssScale=Math.min((width-24)/base.width,(height-24)/base.height);
  const cssWidth=base.width*cssScale,cssHeight=base.height*cssScale;
  // Bound canvas memory independently of display size and monitor scaling.
  const density=Math.min(Math.max(1,Number(pixelRatio)||1),2,4096/cssWidth,4096/cssHeight,Math.sqrt(5_000_000/(cssWidth*cssHeight)));
  return {scale:cssScale*density,cssWidth,cssHeight};
}

// Each attempt owns its canvas. A cancelled/older render cannot clear a newer
// frame, nor reuse a canvas which PDF.js may still be finishing with.
export function createPreviewRenderer({createCanvas,commit}) {
  let generation=0,active=null;
  function cancel(){generation++;active?.cancel();active=null;}
  async function render(page,{width,height,pixelRatio=1}) {
    cancel();const version=generation,base=page.getViewport({scale:1});
    for(let attempt=0;attempt<2;attempt++){
      let canvas,task;
      try{
        if(version!==generation)return {status:'cancelled'};
        const geometry=previewGeometry(base,width,height,attempt?1:pixelRatio),viewport=page.getViewport({scale:geometry.scale});
        canvas=createCanvas();canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
        const context=canvas.getContext('2d');if(!context)throw new Error('Canvas context not supported');
        task=page.render({canvasContext:context,viewport});active=task;
        await task.promise;
        if(version!==generation)return {status:'cancelled'};
        commit(canvas,geometry);return {status:'complete',attempts:attempt+1};
      }catch(error){
        if(version!==generation||error.name==='RenderingCancelledException')return {status:'cancelled'};
        // A smaller fresh canvas helps memory pressure; unsupported APIs and
        // bad resources need a meaningful recovery path, not repeated retries.
        if(attempt===0&&['render_memory','render_conflict'].includes(previewFailure(error).code))continue;
        return {status:'failed',error,attempts:attempt+1};
      }finally{
        if(active===task)active=null;
        if(canvas)canvas.width=canvas.height=0;
      }
    }
  }
  return {render,cancel};
}
