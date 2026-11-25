'use strict';
// Deterministic process fixture; accepts Claude print arguments and never accesses credentials/network.
const args = process.argv.slice(2), stream = args[args.indexOf('--output-format') + 1] === 'stream-json';
const start = Number(process.env.HUB_TTFT_FAKE_START_MS || 300), first = Number(process.env.HUB_TTFT_FAKE_FIRST_MS || 500), end = Number(process.env.HUB_TTFT_FAKE_END_MS || 1800);
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { input += s; });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.on('end', () => {
  const answer = '模拟回答：已依据会议材料核对结论、数字与负责人。';
  if (stream) {
    setTimeout(() => emit({ type: 'system', subtype: 'init' }), start);
    setTimeout(() => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.slice(0, 5) } } }), first);
    setTimeout(() => {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.slice(5) } } });
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
      emit({ type: 'result', subtype: 'success', result: answer });
    }, end);
  } else setTimeout(() => process.stdout.write(answer), end);
});
