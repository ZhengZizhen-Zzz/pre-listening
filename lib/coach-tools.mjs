import {validateSession, pageDurations, hasPageTimeline, materialCoverage} from '../public/core.mjs';

const sessionSchema = {type:'object',description:'当前用户本次演练的材料、发言与翻页记录；由应用注入，不由模型生成。'};
export const coachTools = [
  {name:'get_page_context',description:'读取指定页的材料原文、实际发言和原始段落编号，保留来源差别；空页码列表读取全场。',inputSchema:{type:'object',properties:{session:sessionSchema,pages:{type:'array',items:{type:'integer',minimum:1},maxItems:60}},required:['session','pages'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  {name:'get_timing_summary',description:'从真实网页翻页时间线计算逐页用时。没有可靠计时时返回缺失原因，不按字数猜测。',inputSchema:{type:'object',properties:{session:sessionSchema},required:['session'],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];

export function callCoachTool(name,args) {
  if(!coachTools.some(tool=>tool.name===name))throw new Error('工具不在允许列表中。');
  const allowed=name==='get_page_context'?['session','pages']:['session'];
  if(!args || Object.keys(args).some(k=>!allowed.includes(k)))throw new Error('工具参数不正确。');
  const session=validateSession(args.session);
  if(name==='get_page_context') {
    if(!Array.isArray(args.pages)||args.pages.length>60||args.pages.some(p=>!Number.isInteger(p)||p<1||p>session.pages.length))throw new Error('页码超出当前材料范围。');
    const pages=new Set(args.pages.length?args.pages:session.pages.map(p=>p.number));
    return {pages:session.pages.filter(p=>pages.has(p.number)),speech:session.segments.filter(s=>pages.has(s.page)),unassignedSpeech:session.segments.filter(s=>s.page===0),coverage:materialCoverage(session.pages.filter(p=>pages.has(p.number)))};
  }
  const reliable=Number.isFinite(session.durationSeconds)&&session.events[0]?.at===0&&hasPageTimeline(session.events,session.pages.length)&&!session.segments.some(s=>s.page===0);
  return {reliable,durationSeconds:session.durationSeconds,targetSeconds:session.targetSeconds,
    excessSeconds:reliable?Math.max(0,Math.round(session.durationSeconds-session.targetSeconds)):null,
    pages:reliable?pageDurations(session.events,session.durationSeconds,session.pages.length).map((seconds,i)=>({page:i+1,seconds:Math.round(seconds)})):[],
    note:reliable?'逐页用时来自网页内翻页记录，包含停顿和回翻；用时长不等于讲得差。':'缺少完整计时或可靠页码记录。请在网页内翻页录音，并核对待分配页码；不会根据文字估算逐页用时。'};
}
