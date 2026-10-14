// Fit restored values, pasted lines and wrapped text without an inner scrollbar.
export function autoGrowTextarea(box) {
  let frame=0, lastWidth=0;
  const fit=()=>{
    frame=0;
    if(!box.getClientRects().length||!box.clientWidth)return;
    box.style.height='auto';
    const style=getComputedStyle(box);
    const borders=parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth);
    box.style.height=`${Math.ceil(box.scrollHeight+borders)}px`;
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(fit);};
  box.addEventListener('input',schedule);
  box.closest('details')?.addEventListener('toggle',schedule);
  window.addEventListener('resize',schedule);
  const observer=new ResizeObserver(()=>{
    const width=box.clientWidth;
    if(width!==lastWidth){lastWidth=width;schedule();}
  });
  observer.observe(box);
  document.fonts?.ready.then(schedule);
  schedule();
  return schedule;
}
