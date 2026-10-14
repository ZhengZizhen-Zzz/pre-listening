// Display grouping never changes the sentence-level evidence or its timestamps.
export function groupTranscript(segments, pages) {
  return [...(segments.some(s=>s.page===0)?[{number:0}]:[]),...pages].map(page => {
    const parts = segments.filter(segment => segment.page === page.number);
    const timed = parts.filter(part => Number.isFinite(part.start) && Number.isFinite(part.end));
    return { page: page.number, parts, text: parts.map(part => part.text).join('\n'),
      start: timed.length ? Math.min(...timed.map(part => part.start)) : null,
      end: timed.length ? Math.max(...timed.map(part => part.end)) : null,
      crossesPage: parts.some(part => part.crossesPage) };
  });
}

export function editPageTranscript(segments, page, text) {
  const previous = segments.filter(segment => segment.page === page);
  if (previous.map(segment => segment.text).join('\n') === text) return segments;
  const next = segments.filter(segment => segment.page !== page).map(segment => ({ ...segment }));
  // Once a whole paragraph is edited, an exact sentence timestamp is no longer
  // defensible. Page replay uses the independent flip timeline instead.
  const id = previous[0]?.id || `s${Math.max(0, ...segments.map(segment => Number(segment.id.slice(1)))) + 1}`;
  if (text.trim()) next.push({ id, page, ...(page===0?{pageStatus:'unassigned'}:{}), text, start: null, end: null, source: 'edited', timingScope: 'page' });
  return next.sort((a, b) => a.page - b.page);
}

export function compileScriptPages(segments, pages, scripts = {}) {
  return groupTranscript(segments.map(segment => ({ ...segment, text: scripts[segment.id]?.text || segment.text })), pages)
    .filter(group => group.text.trim()).map(group => ({ id: group.parts[0].id, page: group.page, text: group.text,
      changed: group.parts.some(segment => Boolean(scripts[segment.id])) }));
}

export function transcriptSource(segments, audioPresent = false) {
  if (segments.some(segment => segment.source === 'asr') || audioPresent && segments.some(segment => Number.isFinite(segment.start))) return 'asr';
  if (segments.some(segment => segment.source === 'edited')) return 'edited';
  return 'manual';
}

// Move assignments only; timestamps and actual words remain unchanged.
export function assignTranscriptPage(segments, ids, page, pageCount) {
  if(!Number.isInteger(page)||page<1||page>pageCount)throw new Error('请选择有效页码。');
  const selected=new Set(ids);
  return segments.map(segment=>{if(!selected.has(segment.id))return segment;const {pageStatus,...rest}=segment;return {...rest,page};});
}
