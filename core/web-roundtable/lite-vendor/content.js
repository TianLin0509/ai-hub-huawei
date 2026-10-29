(() => {
  'use strict';
  if(globalThis.__yuanzhuoLite) return;
  const jobs=new Map();
  // The question this script typed into the box and has not sent. Any real keystroke or paste by the user
  // (a trusted input event) disowns it, so a draft the user typed is never cleared, even if the text matches.
  let ownDraft=null,filling=false;
  document.addEventListener('input',event=>{if(event.isTrusted&&!filling)ownDraft=null;},true);
  const diagnostics={observers:0,timers:0,reads:0,lastError:'',activeRequest:null};
  const cleanUrl=()=>location.origin+location.pathname;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const visible=el=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
  const available=el=>visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';
  // innerText inserts extra blank lines between <p> nodes in rich editors.
  function editableText(node){
    if(node.nodeType===Node.TEXT_NODE)return node.textContent;
    if(node.nodeType!==Node.ELEMENT_NODE)return '';
    if(node.tagName==='BR')return '\n';
    // Placeholders rendered inside the editor (Slate) are not user text.
    // Slate marks an empty line with a zero-width span holding a <br>; the line break itself comes from the block.
    if(node.getAttribute('contenteditable')==='false'||node.hasAttribute('data-slate-placeholder')||node.hasAttribute('data-slate-zero-width'))return '';
    const children=[...node.childNodes];let text='';
    for(let i=0;i<children.length;i++){const child=children[i],block=child.nodeType===Node.ELEMENT_NODE&&['P','DIV'].includes(child.tagName);if(i&&block)text+='\n';text+=block&&child.childNodes.length===1&&child.firstChild.nodeName==='BR'?'':editableText(child);}
    return text;
  }
  const value=el=>el?.tagName==='TEXTAREA'?el.value:el?editableText(el):'';
  // Rich editors may drop blank lines or trailing spaces when pasting; every other character must match in order.
  const sameText=(a,b)=>{const lines=s=>normalized(s).split('\n').map(line=>line.replace(/\s+$/,'')).filter(Boolean).join('\n');return lines(a)===lines(b);};
  const normalized=s=>String(s).replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').trim();
  function find(selectors,root=document){for(const selector of selectors){const found=[...root.querySelectorAll(selector)].find(visible);if(found)return found;}return null;}
  // Sites put editors inside messages too (ChatGPT writing blocks, edit-a-question boxes, canvases). The composer is
  // the editor outside every message; with several left, the one sitting with a send or stop control, else the lowest.
  const inMessage=(el,config)=>[...config.answer,...config.user].some(selector=>el.parentElement?.closest(selector));
  function composerRoot(input,config){let root=input.parentElement;for(let i=0;root&&i<8;i++,root=root.parentElement){if(find(config.send,root)||find(config.stop,root))return root;}return null;}
  function composerInput(config){
    for(const selector of config.input){
      const all=[...document.querySelectorAll(selector)].filter(visible);if(!all.length)continue;
      // A site whose message selector also wraps the composer must not lose its input: fall back to every match.
      const outside=all.filter(el=>!inMessage(el,config)),pool=outside.length?outside:all;if(pool.length===1)return pool[0];
      const withControl=pool.filter(el=>composerRoot(el,config)),best=withControl.length?withControl:pool;
      return best.reduce((a,b)=>b.getBoundingClientRect().bottom>a.getBoundingClientRect().bottom?b:a);
    }
    return null;
  }
  // The send button next to this composer; elsewhere only one that is not inside a message (an edit box's Send).
  function sendButton(input,config){const root=composerRoot(input,config),near=root&&find(config.send,root);if(near)return near;for(const selector of config.send){const found=[...document.querySelectorAll(selector)].find(el=>visible(el)&&!inMessage(el,config));if(found)return found;}return null;}
  function answers(config){for(const selector of config.answer){const found=[...document.querySelectorAll(selector)].filter(el=>visible(el)&&normalized(el.textContent));if(found.length)return found;}return [];}
  function users(config){for(const selector of config.user){const found=[...document.querySelectorAll(selector)].filter(visible);if(found.length)return found;}return [];}
  const bodyNodes=(element,config)=>!element?[]:config.body&&!element.matches('[data-role="assistant"]')?[...element.querySelectorAll(config.body)]:[element];
  const answerText=(element,config)=>bodyNodes(element,config).map(node=>visibleText(node,config)).join('\n\n');
  // Thinking panels, citation chips and recommendation cards are excluded from the answer text.
  function visibleText(node,config){if(!config.exclude)return node.textContent;const copy=node.cloneNode(true);copy.querySelectorAll(config.exclude).forEach(el=>el.remove());return copy.textContent;}
  function answerMarkdown(element,config){
    const lines=bodyNodes(element,config).map(node=>markdown(node,config)).join('\n\n').split('\n'),output=[];let fence=null,blank=false;
    for(const line of lines){const marker=line.match(/^\s*(`{3,}|~{3,})/);if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence=null;}
      if(!fence&&!line.trim()){if(!blank)output.push('');blank=true;}else{output.push(line);blank=false;}}
    return output.join('\n').trim();
  }
  function hash(text){let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return (h>>>0).toString(36)+':'+text.length;}
  function userText(node,config){if(!node)return '';const copy=(config.userBody&&node.querySelector(config.userBody)||node).cloneNode(true);copy.querySelectorAll('button,[role="button"],svg,.icon-button,.kimi-tooltip').forEach(el=>el.remove());
    // Rendered Markdown lists keep their numbers in CSS counters, not textContent.
    // Reconstruct those numbers in the clone; never drop digits from the prompt.
    for(const list of copy.querySelectorAll('ol')){const items=[...list.children].filter(n=>n.tagName==='LI'),step=list.reversed?-1:1;let number=list.hasAttribute('start')?list.start:list.reversed?items.length:1;for(const item of items){if(item.hasAttribute('value'))number=item.value;item.prepend(document.createTextNode(number+'. '));number+=step;}}
    return normalized(value(copy));}
  // Sites expose a stable per-message key under different attributes across page versions.
  function userKey(node,config){if(!node||!config.userKeyAttribute)return null;for(const name of [].concat(config.userKeyAttribute)){const key=node.getAttribute(name);if(key)return key;}return null;}
  // Sites rewrite the question bubble: ChatGPT 2026-10 renders `x` as code (dropping the backticks) and linkifies a
  // URL by repeating part of it. So only letters and digits are compared, ignoring case: every one of the prompt's,
  // in order, with at most a fifth extra on the page, so a different long message cannot pass by accident.
  const promptLetters=text=>String(text).replace(/[\s\p{P}\p{S}\p{Z}]/gu,'').toLowerCase();
  function promptShown(text,prompt){const page=promptLetters(text),want=[...promptLetters(prompt)];if(!want.length)return false;if(page.includes(want.join('')))return true;if(page.length>want.length*1.2+40)return false;let i=0;for(const ch of page)if(ch===want[i]&&++i===want.length)return true;return false;}
  function ownsUser(job,nodes){
    const last=nodes.at(-1);if(!last)return false;
    const text=userText(last,job.config),key=userKey(last,job.config);
    const messageId=job.config.userIdAttribute?last.querySelector('['+job.config.userIdAttribute+']')?.getAttribute(job.config.userIdAttribute):null;
    if(job.anchor){const same=(job.anchor.key?key===job.anchor.key||job.anchor.messageId&&messageId===job.anchor.messageId:nodes.length===job.anchor.userCount)&&hash(text)===job.anchor.textHash;if(same&&messageId)job.anchor.messageId=messageId;return !!same;}
    // Virtual lists may remove older rows; stable site message IDs take precedence over row counts.
    if((key?key===job.baseline.userKey:nodes.length!==job.baseline.userCount+1)||!job.prompt||!promptShown(text,job.prompt))return false;
    job.anchor={userCount:nodes.length,textHash:hash(text),key,messageId};return true;
  }
  function markdown(node,config={}){
    if(node.nodeType===Node.TEXT_NODE)return node.textContent;
    if(node.nodeType!==Node.ELEMENT_NODE)return '';
    const tag=node.tagName,md=child=>markdown(child,config);
    if(['SCRIPT','STYLE','BUTTON','SVG','NOSCRIPT'].includes(tag)||node.getAttribute('role')==='button'||node.getAttribute('aria-hidden')==='true'||node.matches('.segment-code-header,.icon-button,.kimi-tooltip')||config.exclude&&node.matches(config.exclude))return '';
    // Rich blocks (ChatGPT's editable email / document drafts) carry the site's own clean copy of their text.
    if(config.copyBlock&&node.matches(config.copyBlock.block)){const copy=node.getAttribute(config.copyBlock.attr),title=config.copyBlock.title&&node.querySelector(config.copyBlock.title)?.value?.trim();if(copy&&copy.trim())return '\n\n'+(title?'**'+title+'**\n\n':'')+copy.trim()+'\n\n';}
    // Site code blocks carry a language label and buttons outside <pre>; read the label, fence the code.
    if(tag==='PRE'||node.matches('.md-code-block,.custom-code-block-container')||config.code&&node.matches(config.code.block)){const code=node.querySelector('pre code,code,pre')||node;const language=(code.className||'').match(/language-([\w-]+)/)?.[1]||node.querySelector('.md-code-block-banner span')?.textContent?.trim()||(config.code&&node.querySelector(config.code.language)?.textContent?.trim().toLowerCase().replace(/\s+/g,'-'))||node.querySelector('[data-language]')?.getAttribute('data-language')||'';
      // CodeMirror (ChatGPT 2026-10) keeps each line in its own element with no newline characters between them.
      const lines=code.querySelectorAll('.cm-line'),body=(lines.length?[...lines].map(line=>line.textContent).join('\n'):visibleText(code,config)).replace(/\n$/,'');const fence='`'.repeat(Math.max(3,...(body.match(/`+/g)||[]).map(s=>s.length+1)));return '\n\n'+fence+language+'\n'+body+'\n'+fence+'\n\n';}
    if(tag==='BR')return '\n';
    if(tag==='IMG')return node.getAttribute('alt')?'['+node.getAttribute('alt')+']':'';
    const text=[...node.childNodes].map(md).join('');
    if(/^H[1-6]$/.test(tag))return '\n\n'+'#'.repeat(Number(tag[1]))+' '+text.trim()+'\n\n';
    if(tag==='CODE')return '`'+text+'`';
    if(tag==='STRONG'||tag==='B'||config.bold&&node.matches(config.bold))return '**'+text+'**';
    if(tag==='EM'||tag==='I'||config.italic&&node.matches(config.italic))return '*'+text+'*';
    if(tag==='LI')return '\n'+(node.parentElement?.tagName==='OL'?[...node.parentElement.children].indexOf(node)+1+'. ':'- ')+text.trim()+'\n';
    if(tag==='BLOCKQUOTE')return '\n\n'+text.trim().split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    if(tag==='A'){const href=node.getAttribute('href')||'';return /^https?:\/\//i.test(href)?'['+text+']('+href.replaceAll(')','%29')+')':text;}
    if(tag==='TR')return '\n| '+[...node.children].map(cell=>md(cell).trim().replaceAll('|','\\|')).join(' | ')+' |'+(headerRow(node)?'\n| '+[...node.children].map(()=>'---').join(' | ')+' |':'');
    return ['P','DIV','SECTION','ARTICLE','UL','OL','TABLE'].includes(tag)?'\n'+text+'\n':text;
  }
  // A header row sits in <thead>, or (ChatGPT 2026-10) is a table's first row made only of <th> cells.
  function headerRow(row){if(row.parentElement?.tagName==='THEAD')return true;const table=row.closest('table');return !!table&&!table.querySelector('thead')&&table.querySelector('tr')===row&&[...row.children].every(cell=>cell.tagName==='TH');}
  function snapshot(config){const nodes=answers(config),last=nodes.at(-1),userNodes=users(config);return {count:nodes.length,lastHash:hash(answerText(last,config)),userCount:userNodes.length,userKey:userKey(userNodes.at(-1),config),url:cleanUrl()};}
  function cleanup(job){if(job.observer){job.observer.disconnect();job.observer=null;diagnostics.observers--;}if(job.timer){clearTimeout(job.timer);job.timer=null;diagnostics.timers--;}if(job.flushTimer){clearTimeout(job.flushTimer);job.flushTimer=null;diagnostics.timers--;}if(diagnostics.activeRequest===job.requestId)diagnostics.activeRequest=null;}
  function retire(job){cleanup(job);job.cancelled=true;job.lastElement=null;job.userAnchor=null;job.lastText='';delete job.prompt;jobs.set(job.requestId,{requestId:job.requestId,status:job.status,sequence:job.sequence,cancelled:true});for(const [key,value] of jobs){if(jobs.size<=32)break;if(value.cancelled)jobs.delete(key);}}
  function emit(job,status,text=job.lastText,error='',extra={}){
    if(job.cancelled)return;
    job.sequence++;job.status=status;
    const message={type:'YZ_EVENT',requestId:job.requestId,sequence:job.sequence,status,text,error,url:job.expectedUrl,anchor:job.anchor,phase:job.dispatched?'attempted':'not_sent',...extra};
    chrome.runtime.sendMessage(message).then(result=>{if(result?.ok===false){diagnostics.lastError=result.error;retire(job);console.warn('[AI圆桌lite] 状态保存失败：',result.error);}}).catch(error=>{diagnostics.lastError=error.message;retire(job);console.warn('[AI圆桌lite] 扩展连接中断：',error.message);});
  }
  // The timed read does not rely on the observer having seen a change: a missed mutation must never stall a round
  // (ChatGPT 2026-10 moved its thread out of <main>; the answer finished on screen and was never read).
  function schedule(job,ms=3000){if(job.cancelled||job.timer)return;diagnostics.timers++;job.timer=setTimeout(()=>{diagnostics.timers--;job.timer=null;job.dirty=true;inspect(job);schedule(job);},ms);}
  function changed(job){job.dirty=true;if(job.cancelled||job.flushTimer)return;diagnostics.timers++;job.flushTimer=setTimeout(()=>{diagnostics.timers--;job.flushTimer=null;inspect(job);},900);}
  function completionMarker(config,element){if(element&&config.complete.some(selector=>element.matches(selector)))return true;let root=element;for(let depth=0;root&&depth<4;depth++,root=root.parentElement){if(depth&&config.answer.some(selector=>root.querySelectorAll(selector).length>1))break;if(find(config.complete,root))return true;}return false;}
  const followsUser=(element,user)=>!!element?.isConnected&&!!user?.isConnected&&!user.contains(element)&&!!(user.compareDocumentPosition(element)&Node.DOCUMENT_POSITION_FOLLOWING);
  function inspect(job,force=false){
    if(job.cancelled||!job.dispatched)return;
    if(job.config.blocked&&find(job.config.blocked)){emit(job,'attention',job.lastText,'网页要求人机验证。请在原网页完成后重新提取；不会自动重发。');retire(job);return;}
    // Guest sessions may accept the prompt and then show a sign-up wall instead of an answer.
    if(loginRequired(job.config)){emit(job,'attention',job.lastText,'网页要求登录后才继续回答，本轮没有收到完整回答。请在原网页登录后重试；不会自动重发。');retire(job);return;}
    const userNodes=users(job.config),hadAnchor=!!job.anchor,owns=ownsUser(job,userNodes);
    // Revalidate on every read, including after a SPA changes URL before replacing DOM.
    if(hadAnchor&&!owns){emit(job,'attention',job.lastText,'网页中的提问已变化，已停止读取，防止混入其他回答。');retire(job);return;}
    if(!job.sending&&cleanUrl()!==job.expectedUrl){
      if(owns&&job.navigationOpen&&Date.now()-job.startedAt<60000&&job.config.conversation.test(location.pathname)){job.expectedUrl=cleanUrl();}
      else if(hadAnchor||job.boundConversation){emit(job,'attention',job.lastText,'网页已切换到其他对话，已停止读取，防止混入别的回答。');retire(job);return;}
    }
    const busy=!!find(job.config.stop)||!!(job.config.busy&&find(job.config.busy));job.sawBusy ||= busy;
    if(busy&&job.lastElement&&job.lastText&&Date.now()-job.changedAt>105000){emit(job,'attention',answerMarkdown(job.lastElement,job.config),'网页仍显示正在生成，但回答已超过 105 秒没有变化。请核对原网页，写完后点“确认已完成”；不会自动重发。',{format:'markdown'});retire(job);return;}
    if(Date.now()-job.startedAt>10*60*1000){emit(job,'attention',job.lastText,'等待超过 10 分钟，已停止自动读取。可打开网页查看，再重新提取。');retire(job);return;}
    if(!owns&&!job.acknowledged){const notice=limitNotice(job.config);if(notice){emit(job,'attention',job.lastText,'已点击发送，但网页提示额度已用完（'+notice+'），提问未被接受；不会自动重发。');retire(job);return;}}
    if(!owns){if(Date.now()-job.startedAt>45000){emit(job,'attention',job.lastText,'无法确认网页中本轮提问的位置，请打开原网页核对；不会自动重发。');retire(job);}return;}
    const currentInput=find(job.config.input);
    if(!job.acknowledged&&job.dispatched&&currentInput&&!normalized(value(currentInput))&&(busy||users(job.config).length>job.baseline.userCount)){job.acknowledged=true;emit(job,'sent');}
    // Virtualized nodes can disappear between reads. Keep the partial text, but
    // never complete from a detached or relocated cached answer.
    if(job.lastElement&&!followsUser(job.lastElement,userNodes.at(-1))){job.lastElement=null;job.dirty=true;}
    if(job.lastElement&&job.lastText&&!busy&&Date.now()-job.changedAt>45000&&!completionMarker(job.config,job.lastElement)&&!job.sawBusy){emit(job,'attention',answerMarkdown(job.lastElement,job.config),'已读到回答，但网页没有可靠的结束信号。请核对全文后确认完成，或重新提取。',{format:'markdown'});retire(job);return;}
    if(!job.dirty&&!force){if(job.lastElement&&job.lastText&&!busy&&Date.now()-job.changedAt>=2200&&(job.sawBusy||completionMarker(job.config,job.lastElement)))finish(job);return;}
    job.dirty=false;diagnostics.reads++;
    const nodes=answers(job.config),candidate=nodes.at(-1);if(!candidate)return;
    // A virtual list may remount older answers and change counts/hashes. Only
    // an answer after this request's user message can belong to this request.
    if(!followsUser(candidate,userNodes.at(-1)))return;
    const raw=answerText(candidate,job.config),currentHash=hash(raw);
    const isNew=nodes.length>job.baseline.count||currentHash!==job.baseline.lastHash;
    if(!isNew)return;
    if(job.config.unsupported&&find(job.config.unsupported,candidate)){emit(job,'attention',answerMarkdown(candidate,job.config)||job.lastText,'网页生成了文档卡片，文档内容尚未提取完整。请打开原网页查看，或在新一轮要求 AI 直接在聊天正文输出。',{format:'markdown'});retire(job);return;}
    if(!normalized(raw))return;
    job.lastElement=candidate;
    if(currentHash!==job.lastHash){job.lastHash=currentHash;job.lastText=raw.trim();job.changedAt=Date.now();job.acknowledged=true;emit(job,'streaming');}
    if(!busy&&Date.now()-job.changedAt>=2200&&(job.sawBusy||completionMarker(job.config,candidate)))finish(job);
    else if(!busy&&Date.now()-job.changedAt>45000){emit(job,'attention',answerMarkdown(candidate,job.config),'已读到回答，但网页没有可靠的结束信号。请核对全文后确认完成，或重新提取。',{format:'markdown'});retire(job);}
  }
  // Content the site fills in after its end signal (ChatGPT writing blocks) holds completion for up to 30 seconds;
  // after that the normal rules apply to whatever is there.
  function pendingContent(job){if(!job.config.pending||!job.lastElement||!find(job.config.pending,job.lastElement))return false;job.pendingSince??=Date.now();return Date.now()-job.pendingSince<30000;}
  function finish(job){if(pendingContent(job)){job.dirty=true;return;}if(!followsUser(job.lastElement,users(job.config).at(-1))){job.lastElement=null;job.dirty=true;return;}const text=answerMarkdown(job.lastElement,job.config);if(!text){emit(job,'attention',job.lastText,'网页答案为空，未标记完成。');}else emit(job,'done',text,job.forced?'按你的确认读取了网页最新回答，未核对提问原文。':'',{format:'markdown'});retire(job);}
  function watch(job){
    for(const other of jobs.values())if(other!==job&&!other.cancelled)retire(other);
    // Observe the whole page: a site may render the conversation outside its <main> landmark.
    job.observer=new MutationObserver(()=>changed(job));job.observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-disabled','aria-label','class']});diagnostics.observers++;diagnostics.activeRequest=job.requestId;job.dirty=true;schedule(job,1000);
  }
  function limitNotice(config){if(!config.limit)return '';for(const selector of config.limit.selectors)for(const el of document.querySelectorAll(selector)){const text=normalized(el.textContent).replace(/\s+/g,' ');if(visible(el)&&config.limit.text.test(text))return text.slice(0,80);}return '';}
  function assertNoLimit(config){const notice=limitNotice(config);if(notice)throw new Error('网页提示额度已用完（'+notice+'），未发送本轮提问。请等待额度恢复或在原网页处理。');}
  function assertNoAttachments(config){if(config.draftAttachment&&find(config.draftAttachment))throw new Error('该网页有尚未发送的附件，请先处理原网页附件草稿；未发送本轮提问。');}
  function pressEnter(input){input.focus();const options={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true,composed:true};for(const type of ['keydown','keypress','keyup'])input.dispatchEvent(new KeyboardEvent(type,options));}
  function clearInput(input){
    input.focus();
    if(input.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'');input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));return;}
    const selection=getSelection(),range=document.createRange();range.selectNodeContents(input);selection.removeAllRanges();selection.addRange(range);document.execCommand('delete',false);
  }
  async function fill(input,text,config,isCancelled){
    input.focus();
    if(input.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));input.dispatchEvent(new Event('change',{bubbles:true}));}
    else{
      const selection=getSelection(),range=document.createRange();range.selectNodeContents(input);selection.removeAllRanges();selection.addRange(range);
      // Let Lexical / ProseMirror perform their own complete multiline paste.
      // Do not dispatch a second insertText event: Lexical may insert it twice.
      // Kimi Lexical converts one long clipboard payload into a TXT file.
      // Insert bounded Unicode-safe chunks into ONE editor, verify the entire
      // assembled prompt below, and click Send only once after all chunks finish.
      const chunked=config.chunkedPaste&&input.matches(config.chunkedPaste),chars=chunked?Array.from(text):null,chunks=chunked?Array.from({length:Math.ceil(chars.length/1000)},(_,i)=>chars.slice(i*1000,(i+1)*1000).join('')):[text];
      for(const chunk of chunks){
        if(isCancelled())return;
        const clipboardData=new DataTransfer();clipboardData.setData('text/plain',chunk);
        if(input.matches('.ProseMirror'))clipboardData.setData('text/html',chunk.split('\n').map(line=>'<p style="white-space: pre-wrap">'+(line?line.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'):'<br>')+'</p>').join(''));
        const paste=new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true});input.dispatchEvent(paste);await sleep(50);if(isCancelled())return;
        assertNoAttachments(config);
        if(!paste.defaultPrevented&&!value(input)){const inserted=document.execCommand('insertText',false,chunk);if(!inserted)throw new Error('该网页未接受文字输入，请打开原网页检查。');}
      }
    }
    await sleep(120);
    const typed=normalized(value(handedOff(input,config,text)));
    if(!sameText(typed,text)){const want=normalized(text);let i=0;while(i<want.length&&want[i]===typed[i])i++;const near=s=>JSON.stringify(s.slice(Math.max(0,i-12),i+12));throw new Error(`网页输入内容与原文不一致，已取消发送（原文 ${want.length} 字，网页 ${typed.length} 字，第 ${i+1} 字起不同：原文 ${near(want)}，网页 ${near(typed)}）。`);}
  }
  function loginRequired(config){if(!config.login)return false;if(config.login.url&&config.login.url.test(location.pathname))return true;return !!(config.login.selectors&&find(config.login.selectors));}
  // 豆包's home composer swaps a textarea for its rich editor (or back) and moves the text itself.
  // Only adapters that declare this follow it, only across element types, and only when the old
  // editor is gone or empty while the new one holds exactly this prompt. A same-type replacement
  // still cancels the send: the page's editor model may no longer hold the text.
  function handedOff(input,config,prompt){if(!config.editorHandoff)return input;const current=composerInput(config);if(current&&current!==input&&current.tagName!==input.tagName&&(!input.isConnected||!visible(input)||!normalized(value(input)))&&sameText(value(current),prompt))return current;return input;}
  // Read-only: what the site shows as its current model / thinking mode. Nothing is clicked; unknown stays empty.
  function readMode(config){const parts=[];for(const spec of config.mode||[]){// Plain specs read one element; pattern specs scan every candidate and (with first) stop at the first match.
    let nodes=[...document.querySelectorAll(spec.select)].filter(visible);if(!spec.all&&!spec.pattern)nodes=nodes.slice(0,1);
    for(const node of nodes){let v=normalized(spec.attr?node.getAttribute(spec.attr)||'':node.innerText||node.textContent||'').replace(/\s+/g,' ');if(spec.pattern){const m=v.match(spec.pattern);if(!m)continue;v=m[1]||m[0];}if(spec.map)v=spec.map[v]||v;if(v&&!parts.includes(v))parts.push(v);if(spec.pattern&&spec.first)break;}}
    return parts.join(' ').slice(0,40);}
  // Read-only check of a member page right after it is connected: signed in, verification, quota, composer.
  async function probe(message){
    const config=globalThis.YuanzhuoAdapters[message.provider];if(!config)throw new Error('不支持该网页。');
    const blocked=()=>!!(config.blocked&&find(config.blocked));let input=composerInput(config);
    for(let i=0;i<27&&!input&&!blocked()&&!loginRequired(config);i++){await sleep(300);input=composerInput(config);}
    // Notices such as Kimi's quota bar render a moment after the composer.
    await sleep(2000);input=composerInput(config);
    return {state:blocked()?'verify':loginRequired(config)?'login':limitNotice(config)?'quota':input?'ok':'noinput',url:cleanUrl()};
  }
  async function prepare(message){
    const config=globalThis.YuanzhuoAdapters[message.provider];if(!config)throw new Error('不支持该网页。');
    if(config.transitional&&find(config.transitional))for(let i=0;i<50&&!find(config.readyWhen);i++)await sleep(300);
    // A saved chat that was just (re)loaded renders its history a moment after the page itself; the baseline below
    // must count those earlier questions, or this round's question cannot be told apart from them afterwards.
    // Placeholder addresses of a chat not yet saved (豆包 /chat/local_…, ChatGPT /c/local-chatgpt:…) have no history.
    if(config.conversation.test(location.pathname)&&!/\/(chat\/local[_-]|c\/local-chatgpt)/.test(decodeURIComponent(location.pathname)))for(let i=0;i<33&&!users(config).length;i++)await sleep(300);
    for(let i=0;i<50&&(find(config.stop)||(config.busy&&find(config.busy)));i++)await sleep(300);
    if(config.blocked&&find(config.blocked))throw new Error('网页要求人机验证，请先在原网页完成验证。');
    if(loginRequired(config))throw new Error('该网页尚未登录。请在原网页登录后再发送；未发送本轮提问。');
    assertNoAttachments(config);assertNoLimit(config);
    // A page opened a moment ago may still be building its composer; waiting here is safe, nothing has been sent.
    let input=composerInput(config);for(let i=0;i<27&&!input;i++){await sleep(300);if(loginRequired(config))throw new Error('该网页尚未登录。请在原网页登录后再发送；未发送本轮提问。');input=composerInput(config);}
    if(!input)throw new Error('未找到可用输入框。请先打开网页完成登录或验证。');
    let leftover=normalized(value(input));const reuse=!!leftover&&!!message.prompt&&sameText(leftover,message.prompt);
    // An earlier round's own question that never went out (failed or skipped member) may still sit in the box.
    // It is ours, not the user's draft, so clear it rather than block every later round on this site.
    if(leftover&&!reuse&&ownDraft&&sameText(leftover,ownDraft)&&(message.stale||[]).some(old=>sameText(leftover,old))){clearInput(input);leftover=normalized(value(input));if(leftover)throw Object.assign(new Error('网页输入框里残留上一轮未发出的提问，未能清空。请在原网页删掉后重试。'),{notSent:true});}
    // The user saw this exact text in the side panel and chose to clear it: remove only that text.
    if(leftover&&!reuse&&message.clearDraft&&sameText(leftover,message.clearDraft)){clearInput(input);leftover=normalized(value(input));if(leftover)throw Object.assign(new Error('网页输入框未能清空，请在原网页删掉后重试。'),{notSent:true});}
    if(leftover&&!reuse)throw Object.assign(new Error('该网页有尚未发送的内容。请先处理原网页草稿，再重试。'),{code:'PAGE_DRAFT',question:leftover});
    if(find(config.stop)||(config.busy&&find(config.busy)))throw new Error('该网页仍在生成其他回答，请等待结束。');
    // The mode caption is informational; a site change there must never block sending.
    let mode='';try{mode=readMode(config);}catch(error){console.info('[AI圆桌lite] 模式读取失败',error.message);}
    return {baseline:snapshot(config),url:cleanUrl(),reuse,mode};
  }
  async function send(message){
    if(jobs.has(message.requestId))return {status:jobs.get(message.requestId).status,duplicate:true};
    const config=globalThis.YuanzhuoAdapters[message.provider];if(!config)throw new Error('不支持该网页。');
    assertNoAttachments(config);
    let input=composerInput(config);if(!input)throw new Error('输入框已消失，请检查登录状态。');
    const reuse=!!normalized(value(input));
    if(reuse&&!sameText(value(input),message.prompt))throw new Error('发送前发现网页已有草稿，未覆盖或发送。');
    if(cleanUrl()!==message.baseline.url)throw new Error('发送前网页对话已变化，已取消发送。');
    const job={...message,config,sequence:0,startedAt:Date.now(),changedAt:Date.now(),lastText:'',lastHash:'',expectedUrl:cleanUrl(),boundConversation:config.conversation.test(location.pathname),cancelled:false,dispatched:false,sawBusy:false,acknowledged:false,sending:true,status:'sending'};
    job.navigationOpen=!job.boundConversation||/\/chat\/local[_-]/.test(location.pathname);
    jobs.set(job.requestId,job);
    try{
      if(!reuse){filling=true;try{await fill(input,message.prompt,config,()=>job.cancelled);}finally{filling=false;}ownDraft=message.prompt;}if(job.cancelled)return {status:'stopped'};assertNoAttachments(config);
      let button=sendButton(input,config);
      // Background tabs render slowly (Claude, ChatGPT): the button can appear seconds after the text. Sites verified to
      // send on Enter wait less, then press Enter instead; either way the watcher confirms the question really went out.
      for(let i=0;i<(config.enterSend?10:40)&&!available(button);i++){await sleep(200);if(job.cancelled)return {status:'stopped'};button=sendButton(input,config);}
      if(!available(button)&&!config.enterSend){retire(job);throw new Error('未找到可用发送按钮，文字保留在网页中，未自动按回车或重试。');}
      // Nothing may yield between final ownership/integrity checks and the click.
      assertNoAttachments(config);assertNoLimit(config);
      input=handedOff(input,config,message.prompt);
      if(!input.isConnected||composerInput(config)!==input)throw new Error('发送前网页输入框已变化，已取消发送，请检查原网页。');
      if(cleanUrl()!==message.baseline.url)throw new Error('发送前网页对话已变化，已取消发送。');
      if(!sameText(value(input),message.prompt))throw new Error('发送前网页输入内容已变化，已取消发送，请检查原网页。');
      const viaEnter=!available(button);
      ownDraft=null;job.dispatched=true;watch(job);if(viaEnter)pressEnter(input);else button.click();job.sending=false;
      emit(job,'unconfirmed','',viaEnter?'未找到可用的发送按钮，已按回车发送，正在核对网页响应；不要重复发送。':'已点击发送，正在核对网页响应；不要重复发送。');
      await sleep(450);inspect(job,true);
      return {status:job.status,phase:'attempted'};
    }catch(error){error.notSent=!job.dispatched;retire(job);throw error;}
  }
  function reread(message){
    if(jobs.has(message.requestId))return {status:jobs.get(message.requestId).status,duplicate:true};
    const config=globalThis.YuanzhuoAdapters[message.provider];
    if(!config)throw new Error('不支持该网页。');
    if(!message.baseline&&!message.force)throw Object.assign(new Error('本轮没有发送记录，需要你确认后再读取网页最新回答。'),{code:'NOT_OWNED',question:userText(users(config).at(-1),config).slice(0,120)});
    if(message.url&&cleanUrl()!==message.url&&!message.force){
      const before=new URL(message.url),finalizing=message.provider==='doubao'&&/^block_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(message.anchor?.key||'')&&message.anchor?.textHash&&before.origin===location.origin&&/^\/chat\/local[_-][^/]+\/?$/.test(before.pathname)&&/^\/chat\/\d+\/?$/.test(location.pathname);
      if(config.conversation.test(before.pathname)&&!finalizing)throw new Error('原网页已切换对话，请先回到本轮原网页。');
    }
    const job={...message,config,sequence:0,startedAt:Date.now(),changedAt:Date.now(),lastText:'',lastHash:'',expectedUrl:cleanUrl(),boundConversation:config.conversation.test(location.pathname),cancelled:false,dispatched:true,sawBusy:false,acknowledged:true,sending:false,status:'sent'};
    const userNodes=users(config),latestUser=userNodes.at(-1);
    if(message.force){
      // The user saw this question and chose it (AI-Arena's manual extraction). Anchor on it, keep watching until it finishes.
      if(!latestUser)throw new Error('网页里还没有提问，无法读取回答。');
      job.anchor={userCount:userNodes.length,textHash:hash(userText(latestUser,config)),key:userKey(latestUser,config),messageId:config.userIdAttribute?latestUser.querySelector('['+config.userIdAttribute+']')?.getAttribute(config.userIdAttribute):null};
      job.baseline=job.baseline||{count:0,lastHash:'',userCount:0,userKey:null,url:cleanUrl()};job.forced=true;
    }else if(!ownsUser(job,userNodes))throw Object.assign(new Error('网页最新提问不属于本轮（与本轮原文对不上），无法自动确认这是本轮的回答。'),{code:'NOT_OWNED',question:userText(latestUser,config).slice(0,120)});
    jobs.set(job.requestId,job);watch(job);inspect(job,true);return {status:job.status};
  }
  function stop(message){const job=jobs.get(message.requestId);if(job&&!job.cancelled){const button=message.stopGeneration?find(job.config.stop):null;job.status='stopped';retire(job);if(available(button)){button.click();return {stopped:true,pageStopped:true};}}else if(!job){retire({requestId:message.requestId,status:'stopped',sequence:0});}return {stopped:true,pageStopped:false};}
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||!message.type?.startsWith('YZ_'))return false;
    (async()=>{switch(message.type){case 'YZ_PING':return {ready:true,diagnostics};case 'YZ_PREPARE':return prepare(message);case 'YZ_PROBE':return probe(message);case 'YZ_SEND':return send(message);case 'YZ_REREAD':return reread(message);case 'YZ_STOP':return stop(message);case 'YZ_LATEST_QUESTION':{const config=globalThis.YuanzhuoAdapters[message.provider];if(!config)throw new Error('不支持该网页。');const last=users(config).at(-1);return {question:last?userText(last,config):'',url:cleanUrl()};}case 'YZ_STATUS':{const job=jobs.get(message.requestId);return {known:!!job,status:job?.status,active:!!job&&!job.cancelled,sequence:job?.sequence||0};}default:throw new Error('未知网页操作。');}})().then(result=>respond({ok:true,...result}),error=>respond({ok:false,error:error.message,code:error.code,question:error.question,
      // Send errors raised before the click (all but the post-click path) mean nothing reached the site.
      notSent:message.type==='YZ_SEND'?error.notSent??true:undefined}));return true;
  });
  addEventListener('pagehide',()=>{for(const job of jobs.values()){cleanup(job);job.cancelled=true;}});
  globalThis.__yuanzhuoLite={diagnostics};
})();
