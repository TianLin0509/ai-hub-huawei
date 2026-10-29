// 精确选择器优先；站点知识参考 AI-Arena 与 2026-09 实测，不继承旧版全局补丁、兜底全文扫描与自动重发。
globalThis.YuanzhuoAdapters = {
  deepseek: {
    // Verified 2026-09-29 (signed in): a scripted Enter in the composer sends; used when no send button is usable.
    enterSend:true,
    input:['#chat-input','textarea[placeholder]'],
    // DeepThink puts its reasoning in .ds-think-content (also .ds-markdown); the reply itself is main-content (2026-09-26).
    answer:['.ds-markdown.ds-assistant-message-main-content','.ds-markdown:not(.ds-think-content .ds-markdown)','[data-role="assistant"]'],
    exclude:'.ds-think-content',
    mode:[{select:'.ds-toggle-button[aria-pressed="true"]',all:true,map:{DeepThink:'深度思考',Search:'联网搜索'}}],
    user:['[data-virtual-list-item-key]:has(.fbb737a4)','[data-role="user"]','[class*="user-message"]','.fbb737a4'],
    userBody:'.fbb737a4',
    userKeyAttribute:'data-virtual-list-item-key',
    send:['[data-testid="send-button"]','[role="button"].ds-button--primary.ds-button--circle:has(svg path[d^="M8.3125 0.98"])','button[aria-label*="发送"]','button[aria-label*="Send"]','[role="button"][aria-label*="发送"]'],
    stop:['[role="button"].ds-button--circle:has(svg path[d^="M2 4.88C2 3.68009"])','button[aria-label*="停止"]','button[aria-label*="Stop"]','[role="button"][aria-label*="停止"]','[data-testid="stop-button"]'],
    complete:['[data-testid="copy-button"]','[role="button"]:has(svg path[d^="M6.14929 4.02032"])','button[aria-label*="复制"]','[role="button"][aria-label*="复制"]','button[aria-label*="Copy"]'],
    // Logged-out states: DeepSeek redirects to /sign_in; the others show a login entry.
    login:{url:/^\/sign_in/},
    conversation:/\/a\/chat\/s\/[^/]+|\/chat\/[^/]+/
  },
  kimi: {
    input:['.ProseMirror[contenteditable="true"]','[role="textbox"][contenteditable="true"]','[contenteditable="true"]','textarea'],
    chunkedPaste:'.chat-input-editor[data-lexical-editor="true"]',
    // A used-up quota shows in the composer bar before Send, or as a modal after it.
    limit:{selectors:['.chat-editor .chat-input-bar','.modal-container'],text:/quota is used up|credits used up|额度已用完|额度用完|次数已用完/i},
    draftAttachment:['[data-testid="input-attachment-list"] .file-card-container','.chat-editor-attachment-area .file-card-container'],
    answer:['.segment-assistant','[class*="segment-assistant"]','[data-role="assistant"]','[class*="assistant-segment"]'],
    body:'.markdown-container:not(.toolcall-content-text) > .markdown',
    user:['.segment-user','[class*="segment-user"]','[data-role="user"]'],
    userBody:'.user-content__text',
    // Kimi marks a temporarily unusable send control with a class; clicking it is a no-op.
    send:['.send-button-container:not(.disabled):has(svg[name="Send"])','button[aria-label*="发送"]','button[aria-label*="Send"]','button[class*="send"]','[data-testid="send-button"]'],
    stop:['.send-button-container.stop','button[aria-label*="停止"]','button[aria-label*="Stop"]','button[class*="stop"]','[class*="stop-button"]'],
    complete:['.segment-assistant-actions .icon-button','button[aria-label*="复制"]','button[aria-label*="Copy"]','[class*="copy-button"]','[data-testid="copy-button"]'],
    login:{selectors:['.not-login-icon','.next-sidebar-history-list__login']},
    mode:[{select:'[data-testid="model-select-trigger"]'},{select:'.current-model .name'}],
    conversation:/\/chat\/[^/]+/
  },
  // Gemini 2026-09: Quill editor. Stop disappears ~1.5 s before the answer body drops
  // aria-busy; message-actions and the "complete" footer appear only after that.
  gemini: {
    // Verified 2026-09-29 (signed in): a scripted Enter in the composer sends; used when no send button is usable.
    enterSend:true,
    input:['rich-textarea .ql-editor[contenteditable="true"]','.ql-editor[contenteditable="true"]','[role="textbox"][contenteditable="true"]'],
    answer:['model-response'],
    body:'.markdown.markdown-main-panel',
    user:['user-query'],
    userBody:'.query-text',
    send:['button[aria-label="Send message"]','button[aria-label*="Send message" i]','button[aria-label*="发送"]','button.send-button'],
    stop:['button[aria-label="Stop response"]','button[aria-label*="Stop response" i]','button[aria-label*="Stop generating" i]','button[aria-label*="停止"]'],
    busy:['model-response .markdown[aria-busy="true"]'],
    complete:['message-actions button[aria-label="Copy"]','message-actions button[aria-label*="Copy" i]','message-actions button[aria-label*="复制"]','.response-footer.complete'],
    code:{block:'code-block',language:'.code-block-decoration > span'},
    // The button text is the mode in every UI language; the English aria-label is the signed-out fallback.
    mode:[{select:'[data-test-id="bard-mode-menu-button"]'},{select:'button[aria-label^="Open mode picker"]',attr:'aria-label',pattern:/currently\s+(.+)$/i}],
    exclude:'.cdk-visually-hidden,model-thoughts,sources-list,.response-footer',
    conversation:/\/app\/[^/]+/
  },
  // ChatGPT 2026-09 (StyleX build): messages are li[data-message-role]; the assistant item gains
  // data-message-complete when finished. Older builds used data-message-author-role.
  chatgpt: {
    input:['textarea#mobile-composer-prompt','textarea[name="prompt"]','#prompt-textarea[contenteditable="true"]','[contenteditable="true"][aria-label="Ask ChatGPT"]','div.ProseMirror[contenteditable="true"]'],
    // 2026-09-27 layout: turns are search units keyed "…:user" / "…:assistant"; message ids live on the unit.
    answer:['li[data-message-role="assistant"]','[data-message-author-role="assistant"]','[data-chatgpt-search-unit-key$=":assistant"]'],
    body:'[data-assistant-markdown],.markdown,[data-markdown-text-style="assistant-message"]',
    user:['li[data-message-role="user"]','[data-message-author-role="user"]','[data-chatgpt-search-unit-key$=":user"]'],
    userBody:'[data-user-message-copy],.whitespace-pre-wrap',
    userKeyAttribute:['id','data-chatgpt-search-message-ids'],
    send:['button[aria-label="Send message"]','button[aria-label="Send prompt"]','[data-testid="send-button"]','button[aria-label="Send"]','button[aria-label*="发送"]'],
    stop:['button[aria-label="Stop streaming"]','button[aria-label*="Stop generating" i]','[data-testid="stop-button"]','button[aria-label*="Stop" i]:not([aria-label*="dictation" i])','button[aria-label*="停止"]'],
    complete:['[data-message-complete]','[data-assistant-message-actions]','[data-testid="copy-turn-action-button"]','.turn-action-controls button[aria-label="Regenerate response"]'],
    exclude:'[data-message-attribution],[data-message-content-controls],[data-assistant-placeholder-slot],[data-markdown-copy="exclude"]',
    // Writing blocks (email / document drafts) carry ChatGPT's own copy of their body; an email subject sits in its own box.
    // 2026-10 renderer: bold and italic are spans marked by attributes, not <strong>/<em>.
    bold:'[data-d-default-strong]',italic:'[data-d-font-style="italic"]',
    copyBlock:{block:'[data-markdown-copy="rich-block"][data-markdown-copy-text]',attr:'data-markdown-copy-text',title:'textarea'},
    // A writing block whose body has not been filled in yet (it re-mounts after the answer ends; slower in background tabs).
    pending:['[data-testid="chatgpt-writing-block"]:not([data-markdown-copy-text])','[data-testid="chatgpt-writing-block"][data-markdown-copy-text=""]'],
    enterSend:true,
    // 2026-09-27 code blocks: a div with a header (language name) and a <code>, no <pre>.
    code:{block:'[data-markdown-copy="code-block"]',language:'[data-markdown-copy="exclude"] .truncate'},
    mode:[{select:'[data-testid="model-switcher-dropdown-button"]'},{select:'button[aria-label="Select ChatGPT model"]'}],
    conversation:/\/u?c\/[^/]+/
  },
  // Claude: ProseMirror editor; the answer body reports data-is-streaming while generating.
  claude: {
    // Verified 2026-09-29 (signed in): a scripted Enter in the composer sends; used when no send button is usable.
    enterSend:true,
    input:['div.ProseMirror[contenteditable="true"]','[contenteditable="true"][role="textbox"]'],
    answer:['[data-is-streaming]'],
    body:'.font-claude-response,.font-claude-message',
    user:['[data-testid="user-message"]'],
    send:['button[aria-label="Send message"]','button[aria-label="Send Message"]','button[aria-label*="发送"]'],
    stop:['button[aria-label="Stop response"]','button[aria-label="Stop Response"]','button[aria-label*="停止"]'],
    busy:['[data-is-streaming="true"]'],
    complete:['[data-is-streaming="false"]'],
    exclude:'.sr-only,details,[data-testid*="thinking" i]',
    login:{url:/^\/(login|logout)/},
    mode:[{select:'[data-testid="model-selector-dropdown"]'}],
    conversation:/\/chat\/[^/]+/
  },
  // Grok: guests get a sign-up card instead of an answer after the first prompt.
  grok: {
    input:['textarea[aria-label="Ask Grok anything"]','div.tiptap.ProseMirror[contenteditable="true"]','[contenteditable="true"][role="textbox"]'],
    answer:['[id^="response-"]:has(.response-content-markdown)'],
    body:'.response-content-markdown',
    user:['[id^="response-"]:not(:has(.response-content-markdown))'],
    send:['button[aria-label="Submit"]','button[aria-label="提交"]','button[type="submit"]'],
    stop:['button[aria-label="Stop model response"]','button[aria-label*="Stop" i]','button[aria-label*="停止"]'],
    complete:['.action-buttons button[aria-label="Copy"]','button[aria-label="Regenerate"]'],
    login:{selectors:['[data-testid="anon-paywall-sign-up-card"]']},
    mode:[{select:'button[aria-label="Model select"]'}],
    conversation:/\/c\/[^/]+/
  },
  // 元宝: Quill editor; one answer is an ai list item, its toolbar shows once finished.
  yuanbao: {
    input:['.ql-editor[contenteditable="true"]','[contenteditable="true"]'],
    answer:['.agent-chat__list__item--ai'],
    body:'.agent-chat__conv--ai__speech_show',
    user:['.agent-chat__list__item--human'],
    userBody:'.hyc-content-text,.agent-chat__bubble__content',
    send:['#yuanbao-send-btn','[class*="send-btn"]:not([class*="disabled"])','button[aria-label*="发送"]','button[aria-label*="Send" i]'],
    stop:['[aria-label="Stop Answering"]','[aria-label*="停止"]','[class*="stop-btn"]'],
    complete:['.agent-chat__conv--ai__toolbar'],
    exclude:'[class*="think"],[class*="process"],[class*="deep-search"],[class*="timeline"],[class*="sources"]',
    login:{selectors:['.agent-dialogue__tool__login','.agent-dialogue__content--common__header.nologin','.hyc-login__dialog']},
    mode:[{select:'[aria-label="Switch model"]'}],
    conversation:/\/chat\/[^/]+\/[^/]+/
  },
  // 千问 (www.qianwen.com) 2026-09: Slate editor; answers carry a feedback toolbar once finished.
  // Recommendation cards after the answer are excluded (AI-Arena qwen-noise-filter).
  qwen: {
    // Verified 2026-09-29 (signed in): a scripted Enter after the pasted text sends; used when no send button is usable.
    enterSend:true,
    input:['[data-slate-editor="true"][contenteditable="true"]','[role="textbox"][contenteditable="true"]'],
    answer:['[data-chat-answers-wrap]'],
    body:'.qk-markdown',
    user:['[data-chat-question-wrap]'],
    userBody:'.question-text-card',
    userKeyAttribute:'data-chat-question-wrap',
    send:['button[aria-label="发送消息"]','button[data-session-switch-target="send-query"]','button[aria-label*="发送"]'],
    stop:['button[aria-label="停止回答"]','button[aria-label*="停止"]'],
    complete:['[data-answer-feedback-toolbar]'],
    exclude:'script,style,.react-syntax-highlighter-line-number,[class*="video_note_list"],[class*="video-item-"],[class*="note-item-"],[class*="doc-item-"],[class*="web-item-"],[class*="hydrate"]',
    code:{block:'.qw-md-code',language:'.sticky span'},
    // After several automated questions Alibaba's baxia check opens a /punish iframe (seen 2026-09-26, AI圆桌 Android too).
    blocked:['.baxia-dialog-content iframe','iframe[src*="/punish"]'],
    mode:[{select:'button',pattern:/^(Qwen\S*)$/,first:true},{select:'button[aria-label="快速"],button[aria-label="思考"],button[aria-label="深度思考"],button[aria-label="思考研究"]',attr:'aria-label',first:true}],
    conversation:/\/chat\/[^/]+/
  },
  doubao: {
    // 2026-09: the home composer stacks tiptap over a textarea that receives the text.
    input:['textarea.semi-input-textarea','textarea','[contenteditable="true"]'],
    editorHandoff:true,
    // The new-chat page first mounts a placeholder textarea; text typed there before the tiptap editor loads
    // can stay unsent (AI圆桌 Android 2026-09-23). Wait for the real editor when the placeholder is showing.
    transitional:['textarea[data-testid="chat_input_input"]'],readyWhen:['.tiptap.ProseMirror[contenteditable="true"]'],
    // 2026-09-23: new conversations render send_message / receive_message with the message ID on
    // message_content; older conversations keep v_list_row[data-observe-row]. Support both.
    answer:['[data-testid="receive_message"]','[class*="v_list_row"][data-observe-row]:not(:has([class*="bg-g-send"]))','[data-role="assistant"]','[class*="assistant"] [class*="content"]'],
    body:'.md-box-root',
    user:['[data-testid="send_message"] [data-testid="message_content"][data-message-id]','[class*="v_list_row"][data-observe-row]:has([class*="bg-g-send"])','[data-role="user"]'],
    userKeyAttribute:['data-observe-row','data-message-id'],
    userBody:'.md-box-root',
    userIdAttribute:'data-message-id',
    // Conversation index entries are buttons whose aria-label is a full earlier prompt.
    send:['#flow-end-msg-send','button[class*="send-msg-btn"]:not([data-index-entry-key])','button[class*="g-send-msg"]:not([data-index-entry-key])','button[aria-label*="发送"]:not([data-index-entry-key])','[data-testid="send-button"]'],
    stop:['[class*="break-btn"]:has(svg path[d^="M12 0.5C18.3513"])','button[aria-label*="停止"]:not([data-index-entry-key])','button[aria-label*="Stop"]:not([data-index-entry-key])','button[class*="stop"]:not([data-index-entry-key])','[data-testid="stop-button"]'],
    complete:['[data-foundation-type="receive-message-action-bar"] button','button[aria-label*="复制"]:not([data-index-entry-key])','[data-testid="copy-button"]','[class*="copy-button"]','button[aria-label*="Copy"]:not([data-index-entry-key])'],
    busy:['.md-box-root[data-streaming="true"]'],
    blocked:['iframe[src*="verifycenter/captcha"]'],
    login:{selectors:['[data-testid="to_login_button"]']},
    // Document / artifact cards keep the real content outside the chat body (2026-09-24: artifact_block).
    unsupported:['[data-feishu-office-current-doc-old-card]','[data-plugin-identifier*="artifact_block"]','[data-office-artifact-scale-container]','[data-assembly-preview-card]'],
    conversation:/\/chat\/[^/?]+/
  }
};
