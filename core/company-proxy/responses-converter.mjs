import { midStreamMessage, responsesFailedEvent } from './failure-text.mjs';
import { randomUUID, createHash } from 'node:crypto';
const error = (message, status = 422) => Object.assign(new Error(message), { status, code: 'unsupported_protocol' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const requestFields = new Set([
  'model', 'input', 'instructions', 'stream', 'tools', 'tool_choice',
  'parallel_tool_calls', 'temperature', 'top_p', 'max_output_tokens',
  'reasoning', 'text', 'store', 'previous_response_id', 'include',
  'prompt_cache_key', 'client_metadata', 'metadata',
]);
function toolEntries(tools = [], namespace = null) {
  return tools.flatMap(tool => tool.type === 'namespace'
    ? toolEntries(tool.tools, namespace ? `${namespace}.${tool.name}` : tool.name)
    : [{ tool, namespace, wireName: namespace ? `ns_${createHash('sha256').update(`${namespace}.${tool.name}`).digest('hex').slice(0, 24)}` : tool.name }]);
}
function wireName(name, namespace) { return namespace ? `ns_${createHash('sha256').update(`${namespace}.${name}`).digest('hex').slice(0, 24)}` : name; }
function text(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) throw error('Expected text content');
  return parts.map(part => {
    if (!['input_text', 'output_text', 'text'].includes(part.type) || typeof part.text !== 'string') throw error('Unsupported non-text content');
    return part.text;
  }).join('\n');
}
// Custom tool input goes upstream as {"input": "..."}. When the original argument text from the
// upstream turn is still known and says the same thing, it is replayed byte for byte.
function customArguments(item, resolveToolArguments) {
  const original = resolveToolArguments?.(item.call_id);
  if (typeof original === 'string') {
    try {
      const parsed = JSON.parse(original);
      if (object(parsed) && Object.keys(parsed).length === 1 && parsed.input === item.input) return original;
    } catch { /* fall through */ }
  }
  return JSON.stringify({ input: item.input });
}
export function convertResponsesRequest(body, { mapReasoning, mapText, resolveReasoning, resolveToolArguments } = {}) {
  if (!body || typeof body.model !== 'string') throw error('model is required', 400);
  for (const key of Object.keys(body)) {
    if (!requestFields.has(key)) throw error(`Unsupported request field: ${key}`);
  }
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.some(value => value !== 'reasoning.encrypted_content'))) {
    throw error('Unsupported response include selection');
  }
  if (body.previous_response_id) throw error('previous_response_id requires a verified conversation store');
  if (body.store === true) throw error('Persistent response storage is not implemented');
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: text(body.instructions) });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) throw error('input must be text or an array', 400);
  // One upstream assistant turn may come back from the client as several items in either order:
  // [reasoning] [message] [tool calls...] or [reasoning] [tool calls...] [message]. They are folded
  // into one assistant message until a tool output or another role starts. Reasoning is optional:
  // a model that produced no thinking leaves tool history without any reasoning item, and that is
  // valid. A reasoning item that is present but cannot be replayed is refused (thinking was lost).
  let reasoning = '';
  let turn = null; // the assistant message still open for the current upstream turn
  const openTurn = () => {
    if (!turn) { turn = { role: 'assistant', content: null }; messages.push(turn); }
    if (reasoning) { turn.reasoning_content = (turn.reasoning_content || '') + reasoning; reasoning = ''; }
    return turn;
  };
  for (const item of input) {
    if (item.type === 'reasoning') {
      const value = resolveReasoning?.(item);
      if (typeof value !== 'string') throw error('Reasoning item needs a verified replay mapping');
      if (!value) throw error('Reasoning item could not be replayed (its thinking text is missing)');
      if (turn && (turn.tool_calls || turn.content !== null)) turn = null; // reasoning after a finished turn starts the next one
      reasoning += value;
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const args = item.type === 'custom_tool_call' ? customArguments(item, resolveToolArguments) : item.arguments;
      const target = openTurn();
      (target.tool_calls ||= []).push({ id: item.call_id, type: 'function', function: { name: wireName(item.name, item.namespace), arguments: args } });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      turn = null;
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: text(item.output) });
    } else if (!item.type || item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) throw error('Unsupported message role');
      if (item.role === 'assistant') {
        const target = turn && turn.content === null ? turn : (turn = null, openTurn());
        target.content = text(item.content);
        continue;
      }
      turn = null;
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: text(item.content) });
    } else throw error(`Unsupported input item: ${item.type}`);
  }
  if (reasoning) throw error('Unassociated reasoning item');
  const result = { model: body.model, messages, stream: body.stream === true };
  if (body.tools) result.tools = toolEntries(body.tools).map(({ tool, namespace, wireName }) => {
    const description = namespace ? `[Namespace ${namespace}, tool ${tool.name}] ${tool.description || ''}` : tool.description;
    if (tool.type === 'function') return { type: 'function', function: { name: wireName, ...(description !== undefined ? { description } : {}), parameters: tool.parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
    if (tool.type === 'custom') return { type: 'function', function: {
      name: wireName, description: `${description || ''}\nReturn the exact custom tool input in the JSON string field input.${tool.format ? ` Original tool format: ${JSON.stringify(tool.format)}` : ''}`,
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
    } };
    throw error(`Unsupported tool type: ${tool.type}`);
  });
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') result.tool_choice = body.tool_choice;
    else if (['function', 'custom'].includes(body.tool_choice.type)) result.tool_choice = { type: 'function', function: { name: wireName(body.tool_choice.name, body.tool_choice.namespace) } };
    else throw error('Unsupported tool choice');
  }
  for (const key of ['parallel_tool_calls', 'temperature', 'top_p']) if (body[key] !== undefined) result[key] = body[key];
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.reasoning !== undefined) {
    if (!mapReasoning) throw error('reasoning needs a verified upstream mapping');
    Object.assign(result, mapReasoning(body.reasoning));
  }
  if (body.text !== undefined) {
    if (!mapText) throw error('text configuration needs a verified upstream mapping');
    Object.assign(result, mapText(body.text));
  }
  if (result.model !== body.model) throw error('Protocol control mapping must not change the requested model');
  // Only the explicit metadata fields above are omitted. The optional
  // reasoning.encrypted_content selection does not require an opaque value when
  // this upstream supplies none. No native caching or persistence is claimed.
  return result;
}

export async function convertChatToResponses(response, { signal, request, rememberReasoning, rememberToolArguments, requireUpstreamModel = false } = {}) {
  if (typeof requireUpstreamModel !== 'boolean') throw error('Invalid upstream model verification option');
  if (!response.ok) return response;
  if (!response.body || !(response.headers.get('content-type') || '').includes('text/event-stream')) throw error('Responses bridge requires Chat SSE', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let cancelled = false;
  const cancel = async () => { cancelled = true; await reader.cancel(); };
  const abort = () => { void cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const output = [];
  const id = `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const tools = new Map(toolEntries(request?.tools).map(entry => [entry.wireName, entry]));
  const envelope = (status, usage = null, incomplete_details = null) => ({ id, object: 'response', created_at: created, status, model: request?.model, output, error: null, incomplete_details, usage });
  const stream = new ReadableStream({
    async start(controller) {
      let sequence = 0, buffer = '', done = false, finish = null, usage = null, modelObserved = false;
      let message = null, messageIndex = null, reasoning = '', reasoningItem = null, reasoningIndex = null;
      const calls = new Map();
      const emit = (type, data) => { if (cancelled) throw signal?.reason || error('Response cancelled', 499); controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data, sequence_number: sequence++ })}\n\n`)); };
      const accept = raw => {
        if (raw === '[DONE]') { done = true; return; }
        const chunk = JSON.parse(raw);
        if (chunk.error) throw error('Upstream returned a streaming error', 502);
        if (chunk.model && request?.model && chunk.model !== request.model) throw error('Upstream model identity differs from the requested model', 502);
        if (typeof chunk.model === 'string' && chunk.model === request?.model) modelObserved = true;
        if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0, total_tokens: chunk.usage.total_tokens ?? ((chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0)), input_tokens_details: { cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 }, output_tokens_details: { reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0 } };
        const choice = chunk.choices?.[0]; if (!choice) return;
        const delta = choice.delta || {};
        if (delta.reasoning_content) {
          if (!rememberReasoning) throw error('Reasoning output needs a replay store', 502);
          if (!reasoningItem) {
            reasoningIndex = output.length;
            reasoningItem = { id: `rs_${randomUUID()}`, type: 'reasoning', summary: [], status: 'in_progress' };
            output.push(reasoningItem);
            emit('response.output_item.added', { output_index: reasoningIndex, item: reasoningItem });
            reasoningItem.summary.push({ type: 'summary_text', text: '' });
            emit('response.reasoning_summary_part.added', { item_id: reasoningItem.id, output_index: reasoningIndex, summary_index: 0, part: reasoningItem.summary[0] });
          }
          reasoning += delta.reasoning_content;
          reasoningItem.summary[0].text = reasoning;
          emit('response.reasoning_summary_text.delta', { item_id: reasoningItem.id, output_index: reasoningIndex, summary_index: 0, delta: delta.reasoning_content });
        }
        if (delta.content) {
          if (typeof delta.content !== 'string') throw error('Unsupported upstream content', 502);
          if (!message) {
            messageIndex = output.length;
            message = { id: `msg_${randomUUID()}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
            output.push(message);
            emit('response.output_item.added', { output_index: messageIndex, item: message });
            message.content.push({ type: 'output_text', text: '', annotations: [], logprobs: [] });
            emit('response.content_part.added', { item_id: message.id, output_index: messageIndex, content_index: 0, part: message.content[0] });
          }
          message.content[0].text += delta.content;
          emit('response.output_text.delta', { item_id: message.id, output_index: messageIndex, content_index: 0, delta: delta.content, logprobs: [] });
        }
        for (const call of delta.tool_calls || []) {
          const state = calls.get(call.index) || { id: '', name: '', args: '' };
          if (call.id) state.id += call.id;
          if (call.function?.name) state.name += call.function.name;
          if (call.function?.arguments) state.args += call.function.arguments;
          calls.set(call.index, state);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      };
      try {
        emit('response.created', { response: envelope('in_progress') });
        emit('response.in_progress', { response: envelope('in_progress') });
        while (!done) {
          const read = await reader.read();
          if (cancelled) throw signal?.reason || error('Response cancelled', 499);
          buffer += decoder.decode(read.value, { stream: !read.done });
          buffer = buffer.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) accept(data);
          }
          if (read.done) break;
        }
        if (!done || !finish || buffer.trim()) throw error('Truncated upstream SSE response', 502);
        if (requireUpstreamModel && !modelObserved) throw error('Upstream model identity was not observed', 502);
        if (!['stop', 'tool_calls', 'length'].includes(finish)) throw error('Unsupported upstream finish reason', 502);
        if (reasoning) {
          // Full upstream reasoning is displayed without claiming OpenAI encryption.
          // Replay requires explicit per-session storage owned by the caller.
          await rememberReasoning(reasoningItem.id, reasoning);
          reasoningItem.status = 'completed';
          emit('response.reasoning_summary_text.done', { item_id: reasoningItem.id, output_index: reasoningIndex, summary_index: 0, text: reasoning });
          emit('response.reasoning_summary_part.done', { item_id: reasoningItem.id, output_index: reasoningIndex, summary_index: 0, part: reasoningItem.summary[0] });
          emit('response.output_item.done', { output_index: reasoningIndex, item: reasoningItem });
        }
        // Items finish in output order (reasoning, text, tool calls), so the client's history replays them in that order.
        if (message) {
          message.status = 'completed';
          emit('response.output_text.done', { item_id: message.id, output_index: messageIndex, content_index: 0, text: message.content[0].text, logprobs: [] });
          emit('response.content_part.done', { item_id: message.id, output_index: messageIndex, content_index: 0, part: message.content[0] });
          emit('response.output_item.done', { output_index: messageIndex, item: message });
        }
        for (const state of calls.values()) {
          if (!state.id || !state.name || !tools.has(state.name)) throw error('Unknown or incomplete tool identity', 502);
          // An upstream tool call without arguments ("") means no arguments.
          if (!state.args.trim()) state.args = '{}';
          let parsed;
          try { parsed = JSON.parse(state.args); } catch { throw error('Invalid upstream tool arguments JSON', 502); }
          if (!object(parsed)) throw error('Tool arguments must be a JSON object', 502);
          const definition = tools.get(state.name);
          const custom = definition.tool.type === 'custom';
          if (custom && (typeof parsed.input !== 'string' || Object.keys(parsed).some(key => key !== 'input'))) throw error('Custom tool input must use one string field', 502);
          const item = { id: `${custom ? 'ctc' : 'fc'}_${randomUUID()}`, type: custom ? 'custom_tool_call' : 'function_call', status: 'completed', call_id: state.id, name: definition.tool.name, ...(definition.namespace ? { namespace: definition.namespace } : {}), ...(custom ? { input: parsed.input } : { arguments: state.args }) };
          if (custom) rememberToolArguments?.(state.id, state.args);
          const output_index = output.length; output.push(item);
          emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) } });
          if (custom) {
            emit('response.custom_tool_call_input.delta', { item_id: item.id, output_index, delta: item.input });
            emit('response.custom_tool_call_input.done', { item_id: item.id, output_index, input: item.input });
          } else {
            emit('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
            emit('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
          }
          emit('response.output_item.done', { output_index, item });
        }
        const incomplete = finish === 'length';
        emit(incomplete ? 'response.incomplete' : 'response.completed', { response: envelope(incomplete ? 'incomplete' : 'completed', usage, incomplete ? { reason: 'max_output_tokens' } : null) });
        controller.close();
      } catch (failure) {
        // The client already has response.created: end the stream the protocol's way, with a readable reason.
        if (cancelled || signal?.aborted) { controller.error(failure); return; }
        try {
          controller.enqueue(encoder.encode(responsesFailedEvent(midStreamMessage(failure), envelope('failed', usage), sequence++)));
          controller.close();
        } catch { controller.error(failure); }
      }
      finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    },
    cancel,
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
}
