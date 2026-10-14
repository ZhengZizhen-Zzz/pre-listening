const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
const small={十:10,百:100,千:1000};
export function chineseNumber(text){
  const [whole,fraction,...extra]=text.split('点');if(extra.length||!whole)return null;
  let value;
  if([...whole].every(c=>c in digits))value=Number([...whole].map(c=>digits[c]).join(''));
  else{
    let total=0,section=0,current=0;
    for(const c of whole){
      if(c in digits)current=digits[c];
      else if(c in small){section+=(current||1)*small[c];current=0;}
      else if(c==='万'){total+=(section+current)*10000;section=current=0;}
      else if(c==='亿'){total=(total+section+current)*100000000;section=current=0;}
      else return null;
    }
    value=total+section+current;
  }
  if(fraction!==undefined){if(!fraction||![...fraction].every(c=>c in digits))return null;value+=Number('0.'+[...fraction].map(c=>digits[c]).join(''));}
  return Number.isFinite(value)?String(Number(value.toFixed(8))):null;
}
// A deliberately narrow extra guard: common Chinese headcounts and percentages.
// It does not prove that an existing number is used with the correct subject/unit.
export function numericFacts(text){
  const values=[...text.matchAll(/\d+(?:\.\d+)?(?:%|％)?/g)].map(m=>m[0].replace('％','%'));
  for(const m of text.matchAll(/百分之([零〇一二两三四五六七八九十百千万亿点]+)/g)){const n=chineseNumber(m[1]);if(n!==null)values.push(n+'%');}
  for(const m of text.matchAll(/([零〇一二两三四五六七八九十百千万亿点]+)(?:位|名|人|份|次)/g)){const n=chineseNumber(m[1]);if(n!==null)values.push(n);}
  for(const m of text.matchAll(/([一二两三四五六七八九十])成/g)){const n=chineseNumber(m[1]);if(n!==null)values.push(String(Number(n)*10)+'%');}
  return values;
}
