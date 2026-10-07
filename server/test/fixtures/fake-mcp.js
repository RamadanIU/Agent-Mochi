/* Фальшивый stdio-сервер MCP для тестов: echo и add; печатает в stderr, чтобы проверить, что это не мешает */
import readline from 'node:readline';
const tools = [
  { name: 'echo', description: 'Повторить текст', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Сложить числа', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
process.stderr.write('fake-mcp started\n');
readline.createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' }, instructions: 'FAKE-HINT' } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    const a = m.params.arguments || {};
    send({ id: m.id, result: { content: [{ type: 'text', text: m.params.name === 'echo' ? 'ECHO:' + a.text + ':' + (process.env.FAKE_KEY || '') : String(a.a + a.b) }] } });
  } else send({ id: m.id, error: { code: -32601, message: 'нет метода' } });
});
