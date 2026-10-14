import {createSlideZoom} from './slide-zoom.mjs';
import {createPreviewRenderer,previewFailure} from './preview-renderer.mjs';

export function createSlidePreviews({getPdf,getText,getCurrent,onNavigate,isRecording=()=>false}) {
  let pdfRef, generation=0, opening=0, navigable=false,openedPage=1;
  const cache=new Map(), tasks=new Set();
  const dialog=document.getElementById('slide-preview-dialog'), image=document.getElementById('slide-preview-large');
  const nav=document.getElementById('slide-preview-nav'),prev=document.getElementById('slide-preview-prev'),next=document.getElementById('slide-preview-next');
  const recording=document.getElementById('slide-preview-recording');
  const message=document.getElementById('slide-preview-message'),messageText=document.getElementById('slide-preview-message-text'),retry=document.getElementById('slide-preview-retry');
  const zoom=createSlideZoom({dialog,image,viewport:document.getElementById('slide-preview-viewport'),sheet:document.getElementById('slide-preview-sheet'),range:document.getElementById('slide-zoom-range'),label:document.getElementById('slide-zoom-value'),minus:document.getElementById('slide-zoom-out'),plus:document.getElementById('slide-zoom-in'),fit:document.getElementById('slide-zoom-fit')});
  const largeRenderer=createPreviewRenderer({createCanvas:()=>document.createElement('canvas'),commit:canvas=>{image.src=canvas.toDataURL('image/jpeg',.96);image.hidden=false;}});
  retry.addEventListener('click',()=>open(openedPage,{followCurrent:navigable,resetZoom:false}));
  function updateNavigation(){
    nav.hidden=!navigable;recording.hidden=!navigable||!isRecording();
    if(navigable){const current=getCurrent(),total=getPdf()?.numPages||0;prev.disabled=current<=1;next.disabled=current>=total;document.getElementById('slide-preview-position').textContent=`${current} / ${total}`;}
  }
  function navigate(delta){if(navigable)onNavigate(getCurrent()+delta);}
  prev.addEventListener('click',()=>navigate(-1));next.addEventListener('click',()=>navigate(1));
  dialog.addEventListener('keydown',event=>{
    if(!navigable||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName))return;
    if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();event.stopPropagation();navigate(event.key==='ArrowRight'?1:-1);}
  });
  dialog.addEventListener('close',()=>{navigable=false;opening++;largeRenderer.cancel();image.removeAttribute('src');});
  function sync(){if(dialog.open&&navigable){updateNavigation();void open(getCurrent(),{resetZoom:false});}}
  document.getElementById('close-slide-preview').addEventListener('click',()=>dialog.close());
  function reset(){generation++;opening++;navigable=false;for(const task of tasks)task.cancel();tasks.clear();cache.clear();pdfRef=null;if(dialog.open)dialog.close();image.removeAttribute('src');}
  async function render(root){
    const pdf=getPdf();if(pdfRef!==pdf){reset();pdfRef=pdf;}
    const version=++generation;
    for(const button of root.querySelectorAll('[data-preview-page]')){
      const pageNumber=Number(button.dataset.previewPage),img=button.querySelector('img'),note=button.querySelector('.preview-note');
      if(!pdf){button.disabled=true;note.textContent=getText(pageNumber)||'本条记录没有保存页面预览；可重新导入同一份材料。';continue;}
      try{
        let url=cache.get(pageNumber);
        if(!url){
          const page=await pdf.getPage(pageNumber);if(version!==generation)return;
          const base=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(1000/base.width,750/base.height)});
          const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          const task=page.render({canvasContext:canvas.getContext('2d'),viewport});tasks.add(task);
          try{
            await task.promise;if(version!==generation)return;
            url=canvas.toDataURL('image/jpeg',.88);cache.set(pageNumber,url);
          }finally{tasks.delete(task);canvas.width=canvas.height=0;}
        }
        if(version!==generation)return;
        img.src=url;img.hidden=false;note.textContent=`第 ${pageNumber} 页 · 点击放大`;button.disabled=false;
        button.onclick=()=>{void open(pageNumber,{followCurrent:false});};
      }catch(error){if(version!==generation)return;note.textContent='这一页预览暂时无法打开，原材料仍保留。';button.disabled=true;}
    }
  }
  async function open(pageNumber,{followCurrent=true,resetZoom=true}={}) {
    const pdf=getPdf();if(!pdf)return;
    const request=++opening;largeRenderer.cancel();openedPage=pageNumber;
    navigable=Boolean(followCurrent&&getCurrent&&onNavigate);updateNavigation();
    document.getElementById('slide-preview-title').textContent=`第 ${pageNumber} 页`;
    image.hidden=true;image.alt=`第 ${pageNumber} 页 PPT`;
    message.hidden=false;messageText.textContent='正在显示…';retry.hidden=true;
    if(!dialog.open)dialog.showModal();
    if(resetZoom)zoom.reset();
    try {
      const page=await pdf.getPage(pageNumber);
      if(getPdf()!==pdf||request!==opening)return;
      // Render from the original PDF rather than enlarging the small review
      // thumbnail. The shared renderer caps allocation at five megapixels.
      const result=await largeRenderer.render(page,{width:1824,height:1374,pixelRatio:2});
      if(getPdf()!==pdf||request!==opening||result.status==='cancelled')return;
      if(result.status==='failed')throw result.error;
      message.hidden=true;zoom.refresh();
    } catch(error){
      if(getPdf()!==pdf||request!==opening)return;
      image.hidden=true;message.hidden=false;retry.hidden=false;messageText.textContent=previewFailure(error).message;
    }
  }
  return {render,reset,open,sync};
}
