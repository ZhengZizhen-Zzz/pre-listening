import { callTextModel } from './providers.mjs';
import { TRAINING_RULES } from './training.mjs';
import { validateAnswerRevisionResult } from '../public/answer-revision-core.mjs';
export const ANSWER_REVISION_VERSION = 'answer-revision-2026-10-10.2';

export async function rewriteAnswer(request, config, fetcher = fetch) {
  const prompt = `${TRAINING_RULES}
你现在帮助用户整理对一道听众问题的实际回答。question及其rubric说明题意，feedback是建议而非事实，可能有误。保留用户真实想法和自然口语，只做值得做的改动。
只修改originalAnswer这一条回答。材料和其他页发言仅帮助理解背景，不可拿其中的数字、经历或结果补成用户回答的事实。事实来源仅为originalAnswer和confirmedAnswers中用户明确确认的answer。不要把澄清问题本身当作事实。
如果原回答已经清楚，或只是换几个同义词，返回no_change。不能为了让回答看起来完整而编造选择理由、比较过程、实验、用户访谈、数据或经历。保留否定、对象、因果方向、计划/已完成、假设/结论及不确定性，不能将“也许、尚未验证”改成确定结论。不为迎合评价要点编造内容，也不强迫用户添加问题没有问的内容。
例如原回答只有“访谈可以了解大家的想法”，不能扩写成“我想了解选择因素和取舍，所以要追问具体经历”，即使题目或feedback提到这些；这是补充了用户尚未在回答或确认中说过的个人目的和理由。要补齐这个缺口，应问“你当时最想了解什么，为什么觉得访谈适合？”而不是把一种合理的理论理由当成用户的真实理由。缺少事实时只换词也不算解决。
如果需要用户实际选择理由等事实才能改好，返回needs_input，只问一个必要问题；最多两轮，已确认没有数据时坦诚保留未知，不再要求提供结果。只调整语序、删重复或突出已有理由可以直接给draft。
draft是一份可自然说出口的完整回答，不要编号、标题、占位符或标准答案口吻，最长6000字。reason用一句话解释实质修改，不询问是否采用。
格式三选一：
{"status":"needs_input","question":"一个必要的事实问题","reason":"为什么需要这条信息"}
{"status":"draft","revisedText":"修改后的回答","reason":"实质修改"}
{"status":"no_change","reason":"原回答可以保留的原因"}`;
  // Do not send the whole deck/speech: background is too easily mistaken for
  // this answer's confirmed facts, even by a second model pass.
  const input = {question:request.question.question,rubric:request.question.rubric,
    originalAnswer:request.answer,feedback:request.feedback,confirmedAnswers:request.answers,
    presentationGoal:{audience:request.session.audience,takeaways:request.session.takeaways}};
  const {raw,...metadata} = await callTextModel(prompt,input,{...config,maxOutputTokens:3500},fetcher);
  let result = validateAnswerRevisionResult(raw,request), reviewed = false;
  if (result.status === 'draft') {
    const review = await callTextModel(`${TRAINING_RULES}
你是回答改写核对员。独立对照originalAnswer、confirmedAnswers和draft，判断是否加入未经确认的事实、丢失否定、调换因果、将计划变成果或把不确定改为确定。不要只检查数字，也核对新添的选择理由、研究过程和经历。question/rubric/feedback不是事实来源。禁止将澄清问题本身当作用户确认。
draft.reason只是模型自己的解释，哪怕它声称“已确认”“与原话一致”也不能采信，必须实际在originalAnswer或confirmedAnswers.answer中找到对应含义。没有对应事实而只凭题目猜出的个人动机、比较经历和研究步骤，一律不能通过。例如“访谈能了解想法”不能证明用户的具体研究取舍、决定追问经历或已经比较过问卷。
只改措辞却没有实质帮助时，返回replace及no_change。如果确有事实缺口，返回replace及needs_input，问一个事实问题，不能自己补造。只需删除臆造内容就能改好时返回修正后的完整draft。
可保留：{"decision":"keep"}。
需修正：{"decision":"replace","revision":{"status":"draft","revisedText":"完整修改稿","reason":"修改原因"}}，revision也可为needs_input（含question、reason）或no_change（含reason）。
无法可靠核对：{"decision":"uncertain"}。`,
    {question:request.question.question,originalAnswer:request.answer,confirmedAnswers:request.answers,draft:result},
    {...config,maxOutputTokens:3500},fetcher);
    metadata.usage = {inputTokens:(metadata.usage?.inputTokens||0)+(review.usage?.inputTokens||0),outputTokens:(metadata.usage?.outputTokens||0)+(review.usage?.outputTokens||0)};
    if (review.raw?.decision === 'replace') result = validateAnswerRevisionResult(review.raw.revision,request);
    else if (review.raw?.decision !== 'keep') throw Object.assign(new Error('这份修改稿暂时无法核对，原回答已保留。请稍后重试。'),{status:502});
    reviewed = true;
  }
  return {...result,...metadata,reviewed,promptVersion:ANSWER_REVISION_VERSION,generatedAt:new Date().toISOString()};
}
