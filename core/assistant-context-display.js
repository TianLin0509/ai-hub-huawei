'use strict';
const OPEN = '[AI_HUB_ASSISTANT_CONTEXT_V1]';
const CLOSE = '[/AI_HUB_ASSISTANT_CONTEXT_V1]';
function unwrapNativePaste(text) {
  const pasted=text.match(/^\s*<pasted_content(?:\s+id="([^"<>]*)")?>\s*([\s\S]*?)\s*<\/pasted_content(?:\s+id="([^"<>]*)")?>\s*$/);
  return pasted&&(!pasted[3]||pasted[3]===pasted[1])?pasted[2]:text;
}
// Hub 自己在信封后面追加的尾巴：本轮委托令牌、记忆整理指令（service.withTidyInstruction）。不是用户的话，卡片不显示。
const HUB_SUFFIX_RE=/^\s*(?:本轮工具委托 requestToken：[0-9a-f-]+\s*)?(?:【记忆整理】[\s\S]*)?$/i;
const stripPasteTags=s=>s.replace(/<\/?pasted_content(?:\s+id="[^"<>]*")?>/g,'').trim();

// Display projection only. Native text, receipt identity and stored records stay intact.
// 2026-11-20 用户反馈：卡片、侧栏、桌宠里不该出现信封 JSON。信封前后夹着用户自己的字（如先打字再粘贴）时，
// 那些字照常显示、只把信封换成其中的 userText；信封不完整、JSON 解析失败才原样显示，避免默默丢字。
function assistantContextDisplay(text, purpose) {
  if (!['hub-assistant','hub-photo-assistant'].includes(purpose) || typeof text !== 'string') return null;
  const rawText=text;
  text=unwrapNativePaste(text);
  const start=text.indexOf(OPEN);
  if(start<0)return null;
  const end = text.lastIndexOf(CLOSE);
  if (end < start) return null;
  const json = text.slice(start+OPEN.length, end).trim();
  const prefix=stripPasteTags(text.slice(0,start));
  const rawSuffix=text.slice(end + CLOSE.length);
  const suffix=HUB_SUFFIX_RE.test(rawSuffix)?'':stripPasteTags(rawSuffix);
  try {
    const data = JSON.parse(json);
    if (!data || typeof data.userText !== 'string' || typeof data.role !== 'string'
      || !data.sessions || !Array.isArray(data.sessions.sessions)
      || !data.history || typeof data.history !== 'object' || Array.isArray(data.history)) return null;
    const id=data.history.clientSubmissionId;
    const userText=[prefix,data.userText,suffix].filter(Boolean).join('\n\n');
    return { userText, rawText,
      ...(typeof id==='string'&&id.length>=8&&id.length<=160?{clientSubmissionId:id}:{}) };
  } catch { return null; }
}

// 不看会话用途的人话版本：侧栏预览、回复提醒、桌宠气泡这些只拿到一段文字的地方用。
// 文字里没有助理信封就原样返回。
function assistantContextPlainText(text){
  if(typeof text!=='string'||!text.includes(OPEN))return text;
  const shown=assistantContextDisplay(text,'hub-assistant');
  if(shown)return shown.userText;
  // 旧版存下来的侧栏预览只截了前 60 字，信封不完整：取出能读到的 userText 开头。
  const start=text.indexOf(OPEN),m=text.slice(start+OPEN.length).match(/^\s*\{\s*"userText"\s*:\s*"((?:[^"\\]|\\.)*)("?)/);
  if(!m)return text;
  try{
    const head=JSON.parse('"'+m[1].replace(/\\(u[0-9a-fA-F]{0,3})?$/,'')+'"');
    return (text.slice(0,start).trim()+' '+head).trim().replace(/…$/,'')+(m[2]?'':'…');
  }catch{return text;}
}

function assistantSubmissionText(text,purpose) {
  if(typeof text!=='string'||!['hub-assistant','hub-photo-assistant'].includes(purpose))return text;
  const inner=unwrapNativePaste(text);
  return inner!==text&&assistantContextDisplay(inner,purpose)?inner:text;
}
module.exports = { assistantContextDisplay,assistantContextPlainText,assistantSubmissionText };
