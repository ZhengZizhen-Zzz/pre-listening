export function pageNumbers(total, current) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
  const start = Math.max(2, Math.min(current - 1, total - 4));
  const end = Math.min(total - 1, Math.max(current + 1, 5));
  return [1, ...(start > 2 ? ['…'] : []),
    ...Array.from({length: end - start + 1}, (_, i) => start + i),
    ...(end < total - 1 ? ['…'] : []), total];
}

// Limit the height to the actual slide's fitted width: dragging must enlarge
// the slide, not add empty gray space around it.
export function previewBounds(width, ratio = 16 / 9) {
  const max = Math.max(80, (width - 24) / ratio + 24);
  return {min: Math.min(200, max), max};
}

export function defaultPreviewHeight(width, ratio, viewportHeight) {
  const {min,max}=previewBounds(width,ratio);
  // Fill the material column for landscape decks; long portrait documents
  // remain bounded so the rehearsal controls are still reachable.
  return Math.max(min,Math.min(max,Math.max(360,viewportHeight*.8)));
}

export function createPreviewSizer({area, handle, fitButton, onResize}) {
  let ratio = 16 / 9, preferred = null, dragging = null, timer;
  let previousWidth = 0, previousHeight = 0;
  try { const saved=localStorage.getItem('rehearsal-preview-height'),value=Number(saved);if(saved==='fit')preferred='fit';else if(value>=80&&value<2500)preferred=value; } catch {}
  const bounds = () => previewBounds(area.clientWidth, ratio);
  const persist = () => { try { localStorage.setItem('rehearsal-preview-height', String(preferred)); } catch {} };
  function apply(value) {
    if (!area.clientWidth) return;
    const {min, max} = bounds();
    const height = Math.round(Math.max(min, Math.min(max, value==='fit'?max:(value ?? defaultPreviewHeight(area.clientWidth,ratio,innerHeight)))));
    area.style.height = `${height}px`;
    handle.setAttribute('aria-valuemin', Math.round(min));
    handle.setAttribute('aria-valuemax', Math.round(max));
    handle.setAttribute('aria-valuenow', height);
    handle.setAttribute('aria-valuetext', `预览高度 ${height} 像素`);
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = {id: event.pointerId, y: event.clientY, height: area.clientHeight};
    handle.setPointerCapture(event.pointerId); handle.focus({preventScroll: true});
    document.body.classList.add('resizing-preview');
  });
  handle.addEventListener('pointermove', event => {
    if (dragging?.id !== event.pointerId) return;
    const {min, max} = bounds();
    preferred = Math.max(min, Math.min(max, dragging.height + event.clientY - dragging.y)); apply(preferred);
  });
  function stop() { if (!dragging) return; dragging = null; document.body.classList.remove('resizing-preview'); persist(); }
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
  handle.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const {min, max} = bounds();
    preferred = event.key === 'Home' ? min : event.key === 'End' ? max : Math.max(min, Math.min(max, area.clientHeight + (event.key === 'ArrowDown' ? 40 : -40)));
    apply(preferred); persist();
  });
  fitButton.addEventListener('click', () => { preferred='fit';apply(preferred);persist(); });
  const observer = new ResizeObserver(() => {
    const width = area.clientWidth;
    if (!width) return;
    const widthChanged = width !== previousWidth;
    if (widthChanged) { previousWidth = width; apply(preferred); }
    const height = area.clientHeight;
    if (!widthChanged && height === previousHeight) return;
    previousHeight = height;
    clearTimeout(timer); timer = setTimeout(onResize, 80);
  });
  observer.observe(area); apply(preferred);
  return {setAspectRatio(value) { if (value !== ratio) { ratio = value; apply(preferred); } }};
}
