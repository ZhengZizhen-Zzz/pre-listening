import {createPreviewRenderer,previewFailure} from './preview-renderer.mjs';
import {formatTime} from './core.mjs';
import {presenterNoteSources,presenterTiming} from './presenter-core.mjs';

export function createPresenter({state,onNavigate,onRecord,onTranscribe,onOpen,onClose,getTarget,getTitle,getMessage,renderDemo}) {
  const dialog=document.createElement('dialog');dialog.id='presenter-dialog';dialog.className='presenter-dialog';
  dialog.setAttribute('aria-labelledby','presenter-title');
  dialog.innerHTML=`<header class="presenter-header"><div><strong id="presenter-title">演讲者视图</strong><span id="presenter-deck"></span></div><div class="presenter-actions"><button id="presenter-notes-toggle" class="text-button" aria-pressed="true">隐藏讲稿</button><button id="presenter-fullscreen" class="text-button">全屏</button><button id="presenter-close" class="button secondary" aria-label="退出演讲者视图">退出 ×</button></div></header>
    <div class="presenter-body"><section class="presenter-stage" aria-label="当前幻灯片"><canvas id="presenter-canvas" hidden></canvas><div id="presenter-demo" class="demo-mini-slide" hidden></div><div id="presenter-loading" role="status"></div><button id="presenter-retry" class="button secondary" hidden>重试本页</button></section><aside class="presenter-notes"><div class="presenter-notes-heading"><strong id="presenter-notes-label">本页讲稿</strong><select id="presenter-notes-source" aria-label="讲稿来源" hidden></select><div><button id="presenter-font-smaller" class="text-button" aria-label="缩小讲稿字号">A−</button><button id="presenter-font-larger" class="text-button" aria-label="放大讲稿字号">A＋</button></div></div><div id="presenter-notes-content" tabindex="0"></div><div class="presenter-upcoming"><span id="presenter-next-label">下一页</span><canvas id="presenter-next-canvas" hidden aria-label="下一页预览"></canvas><p id="presenter-next-text" hidden></p></div></aside></div>
    <p id="presenter-message" role="status" hidden></p><footer class="presenter-footer"><div class="presenter-clocks"><div><span id="presenter-record-state">准备开始</span><strong id="presenter-elapsed">00:00</strong></div><div><span>本页累计</span><b id="presenter-page-time">00:00</b></div><div id="presenter-budget"><span id="presenter-budget-label">剩余</span><b id="presenter-remaining">05:00</b></div></div><nav class="presenter-navigation" aria-label="演讲翻页"><button id="presenter-prev" class="button secondary" aria-label="上一页">←</button><span id="presenter-position"></span><button id="presenter-next" class="button secondary" aria-label="下一页">→</button></nav><div class="presenter-record-actions"><button id="presenter-transcribe" class="button secondary" hidden>转写本次发言</button><button id="presenter-record" class="button primary">开始演练</button></div></footer>`;
  document.body.append(dialog);const $=id=>dialog.querySelector('#'+id),stage=dialog.querySelector('.presenter-stage');
  let generation=0,pdfRef,pageRef=0,demoRef=false,interval,resizeTimer,fontSize=20,ownsFullscreen=false;let notesPage='',notesChoice='';
  const makeRenderer=id=>createPreviewRenderer({createCanvas:()=>document.createElement('canvas'),commit:canvas=>{
    const target=$(id);target.width=canvas.width;target.height=canvas.height;target.getContext('2d').drawImage(canvas,0,0);target.hidden=false;
  }});
  const renderer=makeRenderer('presenter-canvas'),nextRenderer=makeRenderer('presenter-next-canvas');
  const isOpen=()=>dialog.open;
  function tick(){
    if(!dialog.open)return;
    const t=presenterTiming(state,getTarget());$('presenter-elapsed').textContent=formatTime(t.elapsed);$('presenter-page-time').textContent=formatTime(t.pageSeconds);
    $('presenter-budget-label').textContent=t.over>0?'已超时':'剩余';$('presenter-remaining').textContent=formatTime(t.over||t.remaining);$('presenter-budget').classList.toggle('over',t.over>0);
    $('presenter-record-state').textContent=state.recording?'录音中':state.recordingStatus==='interrupted'?'录音已中断':state.blob?'本次已结束':'准备开始';
    $('presenter-record-state').classList.toggle('recording',state.recording);
  }
  async function renderSlides(){
    const version=++generation,pdf=state.pdf,page=state.current;pdfRef=pdf;pageRef=page;demoRef=state.demo;
    renderer.cancel();nextRenderer.cancel();$('presenter-canvas').hidden=true;$('presenter-next-canvas').hidden=true;$('presenter-demo').hidden=true;$('presenter-next-text').hidden=true;$('presenter-retry').hidden=true;
    $('presenter-loading').hidden=false;$('presenter-loading').textContent='正在显示…';
    $('presenter-next-label').textContent=page<state.pages.length?`下一页 · ${page+1}`:'已到最后一页';
    if(state.demo){$('presenter-demo').innerHTML=renderDemo(state.pages[page-1]);$('presenter-demo').hidden=false;$('presenter-loading').hidden=true;$('presenter-next-text').textContent=state.pages[page]?.text?.slice(0,120)||'';$('presenter-next-text').hidden=page===state.pages.length;return;}
    if(!pdf||page>pdf.numPages){$('presenter-loading').textContent=state.materialPending?'这一页还在加载…':'本页预览暂不可用，请退出后重新导入材料。';return;}
    try{
      const slide=await pdf.getPage(page);if(version!==generation||!dialog.open)return;
      const result=await renderer.render(slide,{width:stage.clientWidth,height:stage.clientHeight,pixelRatio:devicePixelRatio||1});
      if(version!==generation||!dialog.open||result.status==='cancelled')return;
      if(result.status==='failed')throw result.error;
      $('presenter-loading').hidden=true;
    }catch(e){if(version!==generation)return;$('presenter-loading').textContent=previewFailure(e).message;$('presenter-retry').hidden=false;}
    if(page<pdf.numPages&&version===generation&&dialog.open){
      try{const next=await pdf.getPage(page+1);if(version!==generation||!dialog.open)return;await nextRenderer.render(next,{width:320,height:150,pixelRatio:1});}catch{/* Current slide remains usable if the next thumbnail fails. */}
    }
  }
  function sync(){
    if(!dialog.open)return;if(!state.pages.length){dialog.close();return;}
    $('presenter-deck').textContent=getTitle();$('presenter-position').textContent=`${state.current} / ${state.pages.length}`;
    const locked=state.busy&&!state.materialPending;
    $('presenter-prev').disabled=locked||state.current<=1;$('presenter-next').disabled=locked||state.current>=state.pages.length;
    $('presenter-record').disabled=state.busy||state.demo||!!state.materialPending;
    $('presenter-record').textContent=state.recording?'结束演练':state.recordingStatus==='interrupted'&&state.blob?'继续汇报':state.blob?'重新演练':'开始演练';
    $('presenter-transcribe').hidden=state.recording||!state.blob||state.demo;$('presenter-transcribe').disabled=state.busy;
    const sources=presenterNoteSources(state,state.current),key=`${state.id}:${state.current}`;
    if(notesPage!==key){notesPage=key;notesChoice='';}
    const selected=sources.find(s=>s.id===notesChoice)||sources[0];
    const picker=$('presenter-notes-source');
    if([...picker.options].map(o=>o.value+o.textContent).join('|')!==sources.map(s=>s.id+s.label).join('|'))picker.replaceChildren(...sources.map(s=>new Option(s.label,s.id)));
    picker.hidden=sources.length<2;picker.value=selected?.id||'';
    $('presenter-notes-label').hidden=sources.length>1;$('presenter-notes-label').textContent=selected?.label||'本页讲稿';
    const notes=selected?.text||(['partial','unavailable'].includes(state.notesStatus)?'本页备注未能读取，可将文件另存为 PPTX 后重新导入。':'本页没有讲稿，可以直接看 PPT 练习。');
    if($('presenter-notes-content').textContent!==notes){$('presenter-notes-content').textContent=notes;$('presenter-notes-content').scrollTop=0;}
    const alert=getMessage();$('presenter-message').hidden=!alert.error||!alert.text;$('presenter-message').textContent=alert.text;
    tick();if(pdfRef!==state.pdf||pageRef!==state.current||demoRef!==state.demo)void renderSlides();
  }
  function open(){if(!state.pages.length)return;if(!dialog.open){dialog.showModal();onOpen();pdfRef=null;pageRef=0;interval=setInterval(tick,250);}sync();}
  async function close(){if(ownsFullscreen&&document.fullscreenElement===document.documentElement)await document.exitFullscreen().catch(()=>{});ownsFullscreen=false;dialog.close();}
  $('presenter-close').onclick=close;
  $('presenter-notes-source').onchange=()=>{notesChoice=$('presenter-notes-source').value;sync();};
  $('presenter-prev').onclick=()=>{if(!$('presenter-prev').disabled)onNavigate(state.current-1);};
  $('presenter-next').onclick=()=>{if(!$('presenter-next').disabled)onNavigate(state.current+1);};
  $('presenter-record').onclick=async()=>{await onRecord();sync();};
  $('presenter-transcribe').onclick=async()=>{await close();await onTranscribe();};
  $('presenter-retry').onclick=()=>void renderSlides();
  $('presenter-notes-toggle').onclick=()=>{const hidden=dialog.classList.toggle('notes-hidden');$('presenter-notes-toggle').textContent=hidden?'显示讲稿':'隐藏讲稿';$('presenter-notes-toggle').setAttribute('aria-pressed',String(!hidden));};
  for(const [id,delta]of [['presenter-font-smaller',-2],['presenter-font-larger',2]])$(id).onclick=()=>{fontSize=Math.max(16,Math.min(32,fontSize+delta));$('presenter-notes-content').style.fontSize=fontSize+'px';};
  $('presenter-fullscreen').hidden=!document.documentElement.requestFullscreen;
  $('presenter-fullscreen').onclick=async()=>{try{if(ownsFullscreen&&document.fullscreenElement===document.documentElement)await document.exitFullscreen();else {await document.documentElement.requestFullscreen();ownsFullscreen=true;$('presenter-fullscreen').textContent='退出全屏';}}catch{$('presenter-message').textContent='浏览器暂不支持全屏，可继续在当前视图演练。';$('presenter-message').hidden=false;}};
  document.addEventListener('fullscreenchange',()=>{$('presenter-fullscreen').textContent=ownsFullscreen&&document.fullscreenElement===document.documentElement?'退出全屏':'全屏';});
  document.addEventListener('keydown',event=>{if(!dialog.open)return;if(event.target.closest('input,textarea,select')||document.querySelector('dialog[open]:not(#presenter-dialog)'))return;const button=event.key==='ArrowLeft'?$('presenter-prev'):event.key==='ArrowRight'?$('presenter-next'):null;if(button){event.preventDefault();event.stopPropagation();button.click();}});
  dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});
  dialog.addEventListener('close',()=>{clearInterval(interval);clearTimeout(resizeTimer);generation++;renderer.cancel();nextRenderer.cancel();pdfRef=null;pageRef=0;onClose();});
  new ResizeObserver(()=>{clearTimeout(resizeTimer);if(dialog.open)resizeTimer=setTimeout(()=>void renderSlides(),120);}).observe(stage);
  return {open,sync,isOpen};
}
