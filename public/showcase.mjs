export function mountShowcase({view,loadDemo}) {
  const $=id=>document.getElementById(id);
  document.querySelector('.breadcrumb>span').textContent='交互示例';
  $('record-hint').textContent='这是一轮预设演练，可查看逐页发言与复盘。';
  document.querySelector('.guide-link').href='https://github.com/ZhengZizhen-Zzz/pre-listening/blob/main/docs/SETUP.md';
  document.querySelector('.guide-link .nav-text').textContent='运行完整版 ↗';
  $('demo-button').querySelector('.nav-text').textContent='重新体验';
  $('showcase-review').onclick=()=>view('review');
  $('showcase-rewrite').onclick=()=>{
    view('review');
    const card=document.querySelector('[data-issue-index="0"]');
    card.scrollIntoView({behavior:'smooth',block:'start'});
    card.querySelector('[data-draft]')?.focus({preventScroll:true});
  };
  $('showcase-questions').onclick=()=>{
    view('review');
    // Reuse the product's real entry and its curated question/feedback session.
    $('training-entry').querySelector('[data-start-questions]')?.click();
  };
  $('showcase-reset').onclick=async()=>{await loadDemo();view('review');};
}
