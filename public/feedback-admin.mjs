import {formatTime,pageDurations,pageLabel,hasPageTimeline} from './core.mjs';
const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const helpful={yes:'有帮助',partly:'部分有帮助',no:'没什么帮助',unsure:'还不确定'},judgments={correct:'判断正确',partial:'部分正确',incorrect:'判断不对',unsure:'暂不确定'},adoptions={yes:'愿意采用',no:'不采用',later:'还要考虑'};
const date=v=>new Date(v).toLocaleString('zh-CN'),paragraph=v=>`<p class="text">${esc(v)}</p>`;
let csrf,rows=[],selected,current,requestVersion=0;
async function api(route){const r=await fetch(route,{headers:{'X-Local-Token':csrf},cache:'no-store'}),data=await r.json();if(!r.ok)throw new Error(data.error||'暂时无法读取反馈。');return data;}
function drawList(){
  const term=$('search').value.trim().toLowerCase(),items=rows.filter(r=>[r.nickname,r.title,r.comment].join(' ').toLowerCase().includes(term));
  $('list').innerHTML=items.map(r=>`<button class="feedback-row" data-id="${r.id}" aria-current="${r.id===selected}"><span>${esc(r.nickname||'未填写昵称')} · ${esc(helpful[r.helpful]||'未评价整体帮助')}</span><strong>${esc(r.title)}</strong><small>${date(r.updatedAt)} · ${r.issueCount} 条建议 · ${r.trainingCount} 组练习</small></button>`).join('')||'<p class="muted">暂无匹配反馈。</p>';
  $('list').querySelectorAll('button').forEach(b=>b.onclick=()=>show(b.dataset.id));
}
function drawMetrics(){
  const sum=k=>rows.reduce((s,r)=>s+r[k],0);
  $('metrics').innerHTML=[['收到反馈',rows.length,'同一条演练更新不重复计数'],['浏览器身份',new Set(rows.map(r=>r.participant)).size,'不等同于独立用户人数'],['判断正确',`${sum('correct')} / ${sum('judged')}`,'分母：已填写判断的建议'],['愿意采用',`${sum('willing')} / ${sum('adoptionAnswered')}`,'分母：已填写采纳意愿的建议']].map(([title,n,note])=>`<div class="metric">${title}<strong>${n}</strong><small>${note}</small></div>`).join('');
}
function drawDetail(s){
  const r=s.record,report=r?.report;
  $('detail').innerHTML=`<div class="detail-heading"><div><h2>${esc(r?.title||'使用感受')}</h2><p class="meta">${esc(s.nickname||'未填写昵称')} · ${date(s.updatedAt)} · 第 ${s.revision} 次提交</p></div><button id="export-feedback">导出文字</button></div>
    <div class="tags"><span class="tag">${esc(helpful[s.helpful]||'未评价整体帮助')}</span><span class="tag">用户主动提交</span>${r?`<span class="tag">实际 ${formatTime(r.durationSeconds)} / 目标 ${formatTime(r.targetSeconds)}</span>`:''}</div>
    <h3>使用感受</h3><div class="comment">${esc(s.comment||'未填写')}</div>${r?`
    <h3>AI 当时给出的复盘</h3><p class="meta">${esc(report.model||'历史结果')} · ${esc(report.promptVersion||'未记录版本')}。以下保留提交时的建议，便于排查误判。</p>${paragraph(report.summary)}
    ${report.practiceSuggestions?.length?`<h3>下一步练习</h3>${report.practiceSuggestions.map(p=>`<h4>${esc(p.title)}</h4>${paragraph(p.action)}<blockquote>${esc(p.quote)}</blockquote>`).join('')}`:''}
    ${report.strengths.length?`<details><summary>值得保留的表达</summary>${report.strengths.map(paragraph).join('')}</details>`:''}
    ${report.timePlan?.items.length?`<details><summary>超时压缩方案</summary>${report.timePlan.items.map(i=>`<h4>第 ${esc(i.page)} 页 · ${formatTime(i.currentSeconds)} → ${formatTime(i.targetSeconds)}</h4>${paragraph(i.action)}`).join('')}</details>`:''}
    ${report.issues.map((i,index)=>`<article class="issue"><h3>${index+1}. ${esc(i.title)}</h3><div class="tags"><span class="tag">${pageLabel(i.page)}</span><span class="tag ${i.feedback.judgment==='incorrect'?'warning':''}">${judgments[i.feedback.judgment]||'判断未填写'}</span><span class="tag">${adoptions[i.feedback.adoption]||'采纳意愿未填写'}</span>${i.rewrite.acceptedAt?'<span class="tag">已采用到讲稿</span>':''}</div>
      <h4>用户原话（报告引用）</h4><blockquote>${esc(i.quote)}</blockquote><h4>AI 的理由与建议</h4>${paragraph(i.why)}${paragraph(i.suggestion)}${i.question?paragraph(i.question):''}
      <h4>用户为什么这样判断</h4><div class="comment">${esc(i.feedback.reason||'未填写')}</div>${i.rewrite.revisedText?`<h4>生成的修改稿</h4><blockquote>${esc(i.rewrite.revisedText)}</blockquote>`:''}
      ${i.rewrite.answers.length?`<details><summary>改稿前的事实澄清</summary>${i.rewrite.answers.map(a=>`<h4>${esc(a.question)}</h4>${paragraph(a.answer)}`).join('')}</details>`:''}</article>`).join('')}
    <details><summary>完整材料文字与发言（${r.pages.length} 页）</summary><div class="scroll-list">${r.segments.some(s=>s.page===0)?'<h4>页码待确认的发言</h4>'+r.segments.filter(s=>s.page===0).map(s=>paragraph(s.text)).join(''):''}${r.pages.map((p,index)=>`<h4>第 ${p.number} 页 · ${hasPageTimeline(r.events,r.pages.length)&&!r.segments.some(s=>s.page===0)?formatTime(pageDurations(r.events,r.durationSeconds,r.pages.length)[index]):'未确定本页用时'}</h4><p class="muted">材料文字</p>${paragraph(p.text||'本页未提取到文字')}<p class="muted">实际发言</p>${r.segments.filter(x=>x.page===p.number).map(x=>paragraph(x.text)).join('')||'<p>未记录发言</p>'}`).join('')}</div></details>
    <details><summary>已采用的讲稿（${r.scripts.length} 段）</summary>${r.scripts.map(x=>paragraph(x.text)).join('')||'<p>尚未采用改稿。</p>'}</details>`:''}
    ${s.training.length?`<h3>附带的练习记录</h3>${s.training.map((run,index)=>`<details><summary>${index+1}. ${run.kind==='drill'?'单页重练':'模拟问答'} · ${run.turns.length} 题</summary>${run.turns.map(t=>`<h4>${esc(t.question)}</h4>${t.criteria.map(c=>paragraph(`${c.label}：${c.description}`)).join('')}${t.attempts.map((a,i)=>`<div class="attempt"><strong>第 ${i+1} 次${a.source==='draft'&&!a.feedback?'参考回答（尚未反馈）':'回答'} · ${formatTime(a.durationSeconds)}</strong><blockquote>${esc(a.text||'尚未填写')}</blockquote>${a.feedback?paragraph(a.feedback.summary)+a.feedback.checks.map(c=>paragraph(`${c.label}：${c.reason}`)).join('')+paragraph(a.feedback.nextStep):'<p>尚未生成反馈</p>'}${a.feedback?.comparison?`<h4>前后对照</h4>${a.feedback.comparison.checks.map(c=>`<blockquote>上次：${esc(c.beforeQuote)}<br>本次：${esc(c.afterQuote)}</blockquote>${paragraph(c.reason)}`).join('')}`:''}${a.revision?.revisedText?`<h4>参考说法</h4>${paragraph(a.revision.revisedText)}`:''}${a.revision?.answers?.map(x=>`<h4>事实确认：${esc(x.question)}</h4>${paragraph(x.answer)}`).join('')||''}</div>`).join('')}`).join('')}</details>`).join('')}`:''}
    <p class="stats-note">提交于 ${date(s.createdAt)}，最近更新 ${date(s.updatedAt)}。原始文件和录音未收集；用户自评不等于模型准确率。</p>`;
  $('export-feedback').onclick=()=>{
    const details=[...$('detail').querySelectorAll('details')],open=details.map(d=>d.open);details.forEach(d=>d.open=true);
    const content=$('detail').innerText;details.forEach((d,i)=>d.open=open[i]);
    const url=URL.createObjectURL(new Blob(['\ufeff'+content],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`试用反馈-${s.id.slice(0,8)}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}
async function show(id){const version=++requestVersion;selected=id;drawList();$('status').textContent='正在读取反馈…';try{const s=await api(`/api/feedback-admin/${id}`);if(version!==requestVersion)return;current=s;drawDetail(s);$('status').textContent='';}catch(e){if(version===requestVersion)$('status').textContent=e.message;}}
async function refresh(){
  $('refresh').disabled=true;$('status').textContent='正在读取…';
  try{const h=await (await fetch('/api/health',{cache:'no-store'})).json();if(h.trialMode)throw new Error('请在开发者本机打开反馈后台。');csrf=h.csrf;rows=(await api('/api/feedback-admin')).items;drawMetrics();drawList();$('status').textContent=`已刷新 · ${new Date().toLocaleTimeString('zh-CN')}`;if(selected&&rows.some(r=>r.id===selected))await show(selected);else if(rows.length)await show(rows[0].id);}
  catch(e){$('status').textContent=e.message;}finally{$('refresh').disabled=false;}
}
$('search').addEventListener('input',drawList);$('refresh').onclick=refresh;await refresh();
