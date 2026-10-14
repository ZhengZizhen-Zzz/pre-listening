export function cleanSpeechTerms(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => typeof value === 'string').map(value => value.trim()).filter(value =>
    value.length >= 2 && value.length <= 15 && /^[\p{Script=Han}A-Za-z·\- ]+$/u.test(value)))].slice(0, 80);
}

export function extractSpeechTerms(pages) {
  const text = pages.map(page => page.text).join('\n');
  const names = [...text.matchAll(/(?:导师|汇报人|报告人|指导教师|负责人)[：:\s]+([\p{Script=Han}]{2,4})(?:老师|教授|\s|$)/gu)].map(match => match[1].replace(/老师$|教授$/, ''));
  const phrases = text.split(/[\n\s、，：:；;（）()？！?！。]+/u).filter(value => value.length >= 2 && value.length <= 12);
  return cleanSpeechTerms([...names, ...phrases]);
}
