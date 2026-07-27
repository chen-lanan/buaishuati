// 本地 AI 只辅助“无标签段落是否属于上一道简答题答案”的边界判断。
// 题型、答案字母、判断题补全和选项结构全部由确定性规则最终决定。
let MODEL = typeof window !== 'undefined' ? window.__QUESTION_AI_MODEL__ : null;
const MODEL_VERSION = MODEL && MODEL.version ? MODEL.version : '按需加载';
let modelLoadingPromise = null;
function refreshModel(){ if(!MODEL && typeof window !== 'undefined' && window.__QUESTION_AI_MODEL__) MODEL=window.__QUESTION_AI_MODEL__; return MODEL; }
function loadModel(){
  refreshModel();
  if(MODEL)return Promise.resolve(MODEL);
  if(modelLoadingPromise)return modelLoadingPromise;
  modelLoadingPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='question-ai-model.js';script.async=true;
    script.onload=()=>{refreshModel();MODEL?resolve(MODEL):reject(new Error('模型脚本已加载但数据不存在'));};
    script.onerror=()=>reject(new Error('本地模型资源加载失败'));document.head.appendChild(script);
  }).finally(()=>{modelLoadingPromise=null;});
  return modelLoadingPromise;
}
const FULL_FROM='ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ１２３４５６７８９０（）．：，；？【】';
const FULL_TO='abcdefghijklmnopqrstuvwxyz1234567890().:,;?[]';
const FULL_MAP={};for(let i=0;i<FULL_FROM.length;i+=1)FULL_MAP[FULL_FROM[i]]=FULL_TO[i];
const REGEX_FEATURES=[
 ['qmark',/[?？]/],['blank',/[（(]\s*[）)]/],['option',/(?:^|\s)(?:[（(]?[A-L][）).、．:：])/i],
 ['ans',/(?:答案|参考答案|正确答案|标准答案|答)\s*[:：]/],['analysis',/(?:解析|说明|分析)\s*[:：]/],
 ['judge',/判断|对错|正确或错误|是否正确|答案\s*[:：]?\s*(?:正确|错误|对|错)/],
 ['multi',/哪些|哪几项|多项|可多选|包括|正确的有|错误的有|答案\s*[:：]?\s*[A-L][,，、A-L]+/i],
 ['short',/简述|为什么|如何|有哪些原因|写出|列出|说明|有何|是什么|作用有哪些|含义是什么|原理是什么|应符合哪些规定/],
 ['heading',/^\s*#|第.{0,8}章|标准格式|图片多选题|目录/],
 ['truth',/^(?:答案\s*[:：]?\s*)?(?:正确|错误|对|错|a\s*[（(]\s*正确)/i],
 ['numbered',/^\s*[1-9]\d*\s*[.、．)）]/]
];
function normalize(text=''){
  return String(text||'').toLowerCase().replace(/[Ａ-Ｚ０-９（）．：，；？【】]/g,ch=>FULL_MAP[ch]||ch).replace(/\s+/g,' ').trim();
}
function fnv1a(text){let h=2166136261>>>0;for(let i=0;i<text.length;i+=1){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h>>>0;}
function featureIds(text='',task='relation'){
  refreshModel();if(!MODEL)return[0];const bucket=MODEL.bucket||65536,max=MODEL.maxFeatures||384,t=normalize(text),set=new Set();
  const add=token=>set.add(fnv1a(token)%bucket);add('__task__:'+task);const padded='^'+t+'$';
  for(let n=1;n<=5;n+=1)for(let i=0;i<=padded.length-n;i+=1)add(`c${n}:${padded.slice(i,i+n)}`);
  const segs=t.split(/[\s,，。；;：:、（）()【】\[\]？！?]+/).filter(Boolean);
  segs.slice(0,64).forEach(x=>add('w:'+x.slice(0,16)));
  for(let i=0;i<Math.min(segs.length-1,32);i+=1)add('wb:'+segs[i].slice(-8)+'|'+segs[i+1].slice(0,8));
  REGEX_FEATURES.forEach(([name,re])=>{if(re.test(t))add('r:'+name);});add('len:'+Math.min(31,Math.floor(t.length/8)));
  return Array.from(set).sort((a,b)=>a-b).slice(0,max);
}
function decodeBase64Int8(value=''){const binary=atob(value),buf=new ArrayBuffer(binary.length),u=new Uint8Array(buf);for(let i=0;i<binary.length;i+=1)u[i]=binary.charCodeAt(i)&255;return new Int8Array(buf);}
function ensureDecoded(){
  refreshModel();if(!MODEL)throw new Error('模型资源不存在');if(MODEL.__decoded)return MODEL.__decoded;
  const decoded={embedding:decodeBase64Int8(MODEL.embeddingBase64),tasks:{}};
  Object.keys(MODEL.tasks||{}).forEach(task=>{const part=MODEL.tasks[task];decoded.tasks[task]={weights:decodeBase64Int8(part.weightsBase64)};});
  MODEL.__decoded=decoded;return decoded;
}
function predict(task,text=''){
  refreshModel();if(!MODEL||!MODEL.tasks||!MODEL.tasks[task])return{label:'',confidence:0,probabilities:{}};
  const decoded=ensureDecoded(),ids=featureIds(text,task),dim=MODEL.dim||32,scales=MODEL.embeddingScales||[],vec=new Float64Array(dim),emb=decoded.embedding;
  for(const id of ids){const off=id*dim;for(let d=0;d<dim;d+=1)vec[d]+=emb[off+d]*(Number(scales[d])||1);}
  const inv=1/Math.max(1,ids.length);for(let d=0;d<dim;d+=1)vec[d]*=inv;
  const part=MODEL.tasks[task],w=decoded.tasks[task].weights,logits=part.bias.map(Number);
  for(let c=0;c<part.classes.length;c+=1){let z=Number(logits[c])||0,off=c*dim,scale=Number(part.scales[c])||1;for(let d=0;d<dim;d+=1)z+=w[off+d]*scale*vec[d];logits[c]=z;}
  const mx=Math.max.apply(null,logits),ex=logits.map(v=>Math.exp(v-mx)),sum=ex.reduce((a,b)=>a+b,0)||1,probabilities={};let best=0;
  ex.forEach((v,i)=>{probabilities[part.classes[i]]=v/sum;if(v>ex[best])best=i;});
  return{label:part.classes[best],confidence:ex[best]/sum,probabilities};
}
function strongShortCue(text=''){
  const clean=String(text||'').replace(/\s+/g,'');
  return /(?:简述|写出|列出|说明|为什么|如何|有哪些原因|有何|是什么|有哪些|作用|原理|含义|区别|关系|步骤|措施|方法|注意事项|应符合哪些规定|应做好哪些工作)/.test(clean)&&!/[（(]\s*[）)]/.test(clean);
}
function classifyAnswerBoundary(questionText='',candidate='',context={}){
  refreshModel();if(!MODEL||!questionText||!candidate||context.hasOptions)return{isAnswer:false,confidence:0,reason:''};
  const strong=context.typeHint==='short'||strongShortCue(questionText);if(!strong)return{isAnswer:false,confidence:0,reason:''};
  // 明确题号+问句、选择题空格或选项行永远不交给模型吞并。
  if(/^\s*\d{1,5}\s*[.、．:：)）]/.test(candidate)&&/[？?]|[（(]\s*[）)]/.test(candidate))return{isAnswer:false,confidence:1,reason:'明确新题'};
  if(/^\s*[A-L]\s*[.、．:：)）]/i.test(candidate))return{isAnswer:false,confidence:1,reason:'明确选项'};
  const rel=predict('relation',`Q=${questionText} [SEP] C=${candidate} __TYPE_SHORT__`),role=predict('role',candidate);
  const isAnswer=rel.label==='answer'&&rel.confidence>=.90&&!['question','heading','option'].includes(role.label);
  return{isAnswer,confidence:Math.min(.97,.65*rel.confidence+.35*role.confidence),reason:`本地边界模型：关系${rel.label} ${(rel.confidence*100).toFixed(0)}%，段落${role.label} ${(role.confidence*100).toFixed(0)}%`};
}
function assistQuestion(question){
  const item=Object.assign({},question||{});
  item.options=Array.isArray(item.options)?item.options.map(x=>Object.assign({},x)):[];
  item.answer=Array.isArray(item.answer)?item.answer.slice():[];
  const used=/^本地AI辅助/.test(String(item.answerBoundarySource||''));
  item.aiAssistApplied=used;
  item.aiAssistReason=used?'仅辅助无标签简答答案边界；题型与答案由规则锁定':'';
  item.aiModelVersion=MODEL_VERSION;
  return item;
}
function selfTest(){
  try{
    ensureDecoded();
    const tests=[
      ['role','# 仪表多选题（标准格式）','heading'],
      ['relation','Q=特级动火作业应符合哪些规定？ [SEP] C=4. 在设备或管道上进行特级动火作业时，设备或管道内应保持微正压。 __TYPE_SHORT__','answer'],
      ['relation','Q=气动调节阀的辅助装置各起什么作用？ [SEP] C=3) 手轮机构：系统故障时，可切换进行手动操作。 __TYPE_SHORT__','answer']
    ];
    const details=tests.map(([task,text,expect])=>{const p=predict(task,text);return{task,expect,actual:p.label,confidence:p.confidence,ok:p.label===expect};});
    return{ok:details.every(x=>x.ok),version:MODEL_VERSION,message:details.every(x=>x.ok)?'本地边界模型已加载，3 项真实推理自检通过':'模型推理结果未通过自检',details};
  }catch(error){return{ok:false,version:MODEL_VERSION,message:error.message||String(error)};}
}
async function selfTestAsync(){await loadModel();return selfTest();}
module.exports={MODEL_VERSION,isAvailable:()=>Boolean(refreshModel()),loadModel,predict,classifyAnswerBoundary,assistQuestion,selfTest,selfTestAsync};
