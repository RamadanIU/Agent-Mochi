/* Проводник (вкладка «Файлы»): HTTP API /api/fs/* → исполнитель → диск, и сырые потоки исполнителя через unix-сокет */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { startMochi, registered, client } from './helpers.js';
import { startRunner } from '../lib/runner.js';
import { fsOp } from '../lib/fsx.js';

let m, c, home;
const enc = encodeURIComponent;

before(async () => {
  m = await startMochi();
  c = await registered(m, 'explorer');
  home = (await c.json('/api/fs/info', undefined, 'GET')).j.home;
});
after(async () => { await m?.stop(); });

test('список папки, новая папка и файл, переименование, сведения', async () => {
  const info = (await c.json('/api/fs/info', undefined, 'GET')).j;
  assert.equal(info.home, path.join(m.env.MOCHI_WORK, 'explorer'));
  assert.ok(info.maxUpload > 0);
  let r = await c.json('/api/fs/op', { fop: 'mkdir', path: home, name: 'Фото' });
  assert.equal(r.status, 200); assert.equal(r.j.path, path.join(home, 'Фото'));
  r = await c.json('/api/fs/op', { fop: 'mkdir', path: home, name: 'Фото' });
  assert.equal(r.status, 409); assert.equal(r.j.code, 'EEXIST');
  assert.equal((await c.json('/api/fs/op', { fop: 'mkdir', path: home, name: '../x' })).status, 400);
  r = await c.json('/api/fs/op', { fop: 'newfile', path: home, name: 'заметка.md' });
  assert.equal(r.status, 200);
  fs.writeFileSync(path.join(home, '.скрытый'), 'x');
  fs.symlinkSync('заметка.md', path.join(home, 'ссылка'));
  const l = (await c.json('/api/fs/list?path=' + enc(home), undefined, 'GET')).j;
  const by = Object.fromEntries(l.entries.map(e => [e.n, e]));
  assert.equal(by['Фото'].t, 'd'); assert.equal(by['заметка.md'].t, 'f'); assert.equal(by['.скрытый'].t, 'f');
  assert.equal(by['ссылка'].t, 'l'); assert.equal(by['ссылка'].lt, 'f'); assert.equal(by['ссылка'].lk, 'заметка.md');
  for (const n of ['inbox', 'outbox']) assert.equal(by[n].t, 'd');
  assert.equal(l.w, true); assert.ok(l.df.total > 0);
  r = await c.json('/api/fs/op', { fop: 'rename', path: path.join(home, 'заметка.md'), name: 'README.md' });
  assert.equal(r.j.name, 'README.md');
  const st = (await c.json('/api/fs/stat?path=' + enc(path.join(home, 'Фото')), undefined, 'GET')).j;
  assert.equal(st.t, 'd'); assert.equal(st.items, 0); assert.ok(st.user);
  assert.equal((await c.json('/api/fs/list?path=' + enc(path.join(home, 'нет-такой')), undefined, 'GET')).status, 404);
  assert.equal((await c.json('/api/fs/list?path=' + enc(path.join(home, 'README.md')), undefined, 'GET')).status, 400);
});

test('копирование, перенос, удаление; системные папки и домашнюю папку агента не трогаем', async () => {
  fs.mkdirSync(path.join(home, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(home, 'src/a.txt'), 'a');
  let r = await c.json('/api/fs/op', { fop: 'copy', paths: [path.join(home, 'src/a.txt'), path.join(home, 'src')], dest: path.join(home, 'src') });
  assert.equal(r.status, 200);
  assert.equal(r.j.done[0].name, 'a (копия).txt');
  assert.match(r.j.errors[0].err, /внутрь неё самой/);
  r = await c.json('/api/fs/op', { fop: 'copy', paths: [path.join(home, 'src')], dest: home });
  assert.equal(r.j.done[0].name, 'src (копия)');
  assert.ok(fs.existsSync(path.join(home, 'src (копия)/lib')));
  r = await c.json('/api/fs/op', { fop: 'move', paths: [path.join(home, 'src (копия)')], dest: path.join(home, 'src/lib') });
  assert.equal(r.j.done.length, 1);
  assert.ok(fs.existsSync(path.join(home, 'src/lib/src (копия)/a (копия).txt')));
  r = await c.json('/api/fs/op', { fop: 'move', paths: [path.join(home, 'src')], dest: path.join(home, 'src/lib') });
  assert.match(r.j.errors[0].err, /внутрь неё самой/);
  /* настоящие /etc и / в тесте не трогаем: защита срабатывает по пути, ещё до проверки, есть ли он */
  const top = '/zz-mochi-test-нет-такой';
  r = await c.json('/api/fs/op', { fop: 'delete', paths: [top, m.env.MOCHI_WORK, path.join(home, 'src/lib')] });
  assert.equal(r.j.errors.length, 2);
  for (const e of r.j.errors) assert.match(e.err, /трогать нельзя/);
  assert.equal(r.j.done.length, 1);
  assert.ok(!fs.existsSync(path.join(home, 'src/lib')) && fs.existsSync(m.env.MOCHI_WORK));
  r = await c.json('/api/fs/op', { fop: 'rename', path: top, name: 'etc2' });
  assert.match(r.j.error, /трогать нельзя/);
  assert.equal((await c.json('/api/fs/op', { fop: 'format', path: home })).status, 400);
});

test('сохранение из редактора: CRLF и BOM сохраняются, чужая версия файла — конфликт', async () => {
  const f = path.join(home, 'win.txt');
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('раз\r\nдва\r\n')]));
  const st = (await c.json('/api/fs/stat?path=' + enc(f), undefined, 'GET')).j;
  let r = await c.json('/api/fs/op', { fop: 'write', path: f, content: 'раз\nдва\nтри\n', expect: st.sig });
  assert.equal(r.status, 200);
  assert.deepEqual(fs.readFileSync(f), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('раз\r\nдва\r\nтри\r\n')]));
  r = await c.json('/api/fs/op', { fop: 'write', path: f, content: 'чужое', expect: st.sig });
  assert.equal(r.j.conflict, true);
  fs.writeFileSync(path.join(home, 'cp.txt'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
  r = await c.json('/api/fs/op', { fop: 'write', path: path.join(home, 'cp.txt'), content: 'x' });
  assert.match(r.j.error, /не в UTF-8/);
  r = await c.json('/api/fs/op', { fop: 'write', path: path.join(home, 'new.txt'), content: 'новый', create: true });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(home, 'new.txt'), 'utf8'), 'новый');
});

test('байты файла: диапазоны для перемотки, ETag, безопасные заголовки', async () => {
  const data = Buffer.alloc(300000); for (let i = 0; i < data.length; i++) data[i] = i * 7 & 255;
  fs.writeFileSync(path.join(home, 'clip.mp4'), data);
  fs.writeFileSync(path.join(home, 'page.html'), '<script>alert(1)</script>');
  const u = '/api/fs/raw?path=' + enc(path.join(home, 'clip.mp4'));
  let r = await c(u);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.match(r.headers.get('content-disposition'), /^inline; filename\*=UTF-8''clip\.mp4$/);
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data));
  const etag = r.headers.get('etag');
  r = await c(u, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 1000-1999/300000');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(1000, 2000)));
  r = await c(u, { headers: { range: 'bytes=299990-' } });
  assert.equal(r.headers.get('content-range'), 'bytes 299990-299999/300000');
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  r = await c(u, { headers: { range: 'bytes=-5' } });
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(-5)));
  r = await c(u, { headers: { range: 'bytes=400000-' } });
  assert.equal(r.status, 416); await r.arrayBuffer();
  r = await c(u, { headers: { 'if-none-match': etag } });
  assert.equal(r.status, 304);
  r = await c(u, { method: 'HEAD' });
  assert.equal(r.headers.get('content-length'), '300000');
  /* HTML с сервера никогда не исполняется: текстом и в песочнице */
  r = await c('/api/fs/raw?path=' + enc(path.join(home, 'page.html')));
  assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
  await r.text();
  r = await c('/api/fs/raw?dl=1&path=' + enc(path.join(home, 'clip.mp4')));
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  await r.arrayBuffer();
  r = await c('/api/fs/raw?path=' + enc(home));
  assert.equal(r.status, 400); await r.text();
  /* без входа — ничего */
  const anon = client(m.base);
  r = await anon(u); assert.equal(r.status, 401); await r.text();
});

test('загрузка: без перезаписи, с заменой, обрыв, папка архивом, поиск и размер', async () => {
  const up = (name, body, extra = '') => c('/api/fs/upload?dir=' + enc(home) + '&name=' + enc(name) + extra, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } });
  const big = Buffer.alloc(2 * 2 ** 20 + 11, 9);
  let r = await up('видео.bin', big);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.name, 'видео.bin'); assert.equal(j.size, big.length);
  assert.ok(fs.readFileSync(path.join(home, 'видео.bin')).equals(big));
  j = await (await up('видео.bin', Buffer.from('второй'))).json();
  assert.equal(j.name, 'видео (2).bin');
  j = await (await up('видео.bin', Buffer.from('замена'), '&over=1')).json();
  assert.equal(j.name, 'видео.bin');
  assert.equal(fs.readFileSync(path.join(home, 'видео.bin'), 'utf8'), 'замена');
  r = await up('../evil', Buffer.from('x'));
  assert.equal(r.status, 400); await r.text();
  /* CSRF: без заголовка X-Mochi загрузить нельзя */
  r = await c('/api/fs/upload?dir=' + enc(home) + '&name=x', { method: 'PUT', body: 'x', headers: { 'x-mochi': '' } });
  assert.equal(r.status, 403); await r.text();
  /* обрыв посреди загрузки: недописанного файла не остаётся */
  await new Promise(ok => {
    const s = net.createConnection(m.port, '127.0.0.1', () => {
      s.write(`PUT /api/fs/upload?dir=${enc(home)}&name=half.bin HTTP/1.1\r\nHost: 127.0.0.1:${m.port}\r\nx-mochi: 1\r\ncookie: ${c.cookie()}\r\ncontent-length: 100000\r\n\r\n`);
      s.write(Buffer.alloc(5000, 1));
      setTimeout(() => { s.destroy(); ok(); }, 200);
    });
  });
  for (let i = 0; i < 30 && fs.readdirSync(home).some(n => /half/.test(n)); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(!fs.readdirSync(home).some(n => /half/.test(n)), fs.readdirSync(home).join(', '));
  /* папка — архивом .tar.gz */
  fs.mkdirSync(path.join(home, 'архив/вложенная'), { recursive: true });
  fs.writeFileSync(path.join(home, 'архив/вложенная/f.txt'), 'внутри');
  r = await c('/api/fs/tar?path=' + enc(path.join(home, 'архив')));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /\.tar\.gz$/);
  const gz = Buffer.from(await r.arrayBuffer());
  assert.equal(gz[0], 0x1f); assert.equal(gz[1], 0x8b);
  /* поиск по имени вглубь и размер папки */
  j = (await c.json('/api/fs/search?path=' + enc(home) + '&q=' + enc('f.txt'), undefined, 'GET')).j;
  assert.deepEqual(j.entries.map(e => [e.n, e.d]), [['f.txt', path.join(home, 'архив/вложенная')]]);
  j = (await c.json('/api/fs/search?path=' + enc(home) + '&q=' + enc('*.BIN'), undefined, 'GET')).j;
  assert.deepEqual(j.entries.map(e => e.n).sort(), ['видео (2).bin', 'видео.bin']);
  j = (await c.json('/api/fs/du?path=' + enc(path.join(home, 'архив')), undefined, 'GET')).j;
  assert.deepEqual([j.size, j.files, j.dirs], [Buffer.byteLength('внутри'), 1, 1]);
});

test('архивы: что внутри zip и tar.gz, распаковка рядом (без «..» и абсолютных путей), сжатие выделенного', async () => {
  const dir = path.join(home, 'arc');
  fs.mkdirSync(path.join(dir, 'src/sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.txt'), 'А'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'src/sub/b.txt'), 'b');
  /* сжать: только из одной папки */
  let r = await c.json('/api/fs/op', { fop: 'pack', paths: [path.join(dir, 'src')] });
  assert.equal(r.status, 200); assert.equal(r.j.name, 'src.tar.gz');
  assert.match((await c.json('/api/fs/op', { fop: 'pack', paths: [path.join(dir, 'src'), path.join(home, 'README.md')] })).j.error, /из одной папки/);
  let j = (await c.json('/api/fs/archive?path=' + enc(path.join(dir, 'src.tar.gz')), undefined, 'GET')).j;
  assert.equal(j.kind, 'tar');
  assert.deepEqual(j.entries.filter(e => !e.d).map(e => e.n).sort(), ['src/a.txt', 'src/sub/b.txt']);
  r = await c.json('/api/fs/op', { fop: 'extract', path: path.join(dir, 'src.tar.gz') });
  assert.equal(r.j.name, 'src (2)');
  assert.equal(fs.readFileSync(path.join(dir, 'src (2)/src/sub/b.txt'), 'utf8'), 'b');
  /* zip, собранный вручную: обычный файл (deflate), папка и два «злых» пути */
  const zlib = await import('node:zlib');
  const files = [['docs/', ''], ['docs/x.txt', 'привет '.repeat(50)], ['../evil.txt', 'зло'], ['/abs.txt', 'зло']];
  const parts = [], cd = [];
  let off = 0;
  for (const [n, body] of files) {
    const name = Buffer.from(n), raw = Buffer.from(body), data = n.endsWith('/') ? raw : zlib.deflateRawSync(raw), method = n.endsWith('/') ? 0 : 8;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(zlib.crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(zlib.crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    parts.push(lh, name, data); cd.push(ch, name); off += 30 + name.length + data.length;
  }
  const cdb = Buffer.concat(cd), eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(files.length, 8); eo.writeUInt16LE(files.length, 10); eo.writeUInt32LE(cdb.length, 12); eo.writeUInt32LE(off, 16);
  fs.writeFileSync(path.join(dir, 'набор.zip'), Buffer.concat([...parts, cdb, eo]));
  j = (await c.json('/api/fs/archive?path=' + enc(path.join(dir, 'набор.zip')), undefined, 'GET')).j;
  assert.equal(j.kind, 'zip');
  assert.deepEqual(j.entries.map(e => e.n), ['docs/', 'docs/x.txt', '../evil.txt', '/abs.txt']);
  r = await c.json('/api/fs/op', { fop: 'extract', path: path.join(dir, 'набор.zip') });
  /* «../evil.txt» пропущен, «/abs.txt» — как у tar: без ведущего «/», внутри новой папки */
  assert.equal(r.status, 200); assert.equal(r.j.name, 'набор'); assert.equal(r.j.files, 2); assert.equal(r.j.skipped, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'набор/docs/x.txt'), 'utf8'), 'привет '.repeat(50));
  assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')) && !fs.existsSync(path.join(home, 'evil.txt')) && !fs.existsSync('/abs.txt'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'набор')).sort(), ['abs.txt', 'docs']);
  /* не архив */
  assert.equal((await c.json('/api/fs/archive?path=' + enc(path.join(dir, 'src/a.txt')), undefined, 'GET')).status, 400);
  /* права */
  r = await c.json('/api/fs/op', { fop: 'chmod', path: path.join(dir, 'src/a.txt'), mode: 0o755 });
  assert.equal(r.status, 200);
  assert.equal(fs.statSync(path.join(dir, 'src/a.txt')).mode & 0o777, 0o755);
});

test('исполнитель: JSON-операции и сырые потоки get/put на отдельных соединениях', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-fsr-')), sock = path.join(dir, 'r.sock');
  const srv = startRunner(sock);
  await new Promise(r => setTimeout(r, 100));
  fs.writeFileSync(path.join(dir, 'f.bin'), Buffer.from('0123456789'));
  const raw = (head, body) => new Promise(ok => {
    const s = net.createConnection(sock, () => { s.write(JSON.stringify(head) + '\n'); if (body) s.write(body); });
    const parts = []; s.on('data', d => parts.push(d)); s.on('end', () => ok(Buffer.concat(parts)));
  });
  let out = await raw({ op: 'get', path: path.join(dir, 'f.bin'), start: 2, end: 4 });
  const nl = out.indexOf(10), head = JSON.parse(out.subarray(0, nl));
  assert.equal(head.size, 10); assert.equal(out.subarray(nl + 1).toString(), '234');
  out = await raw({ op: 'put', dir, name: 'n.txt', size: 4 }, 'ab\ncd');
  assert.equal(JSON.parse(out).name, 'n.txt');
  assert.equal(fs.readFileSync(path.join(dir, 'n.txt'), 'utf8'), 'ab\nc');
  out = await raw({ op: 'get', path: path.join(dir, 'нет') });
  assert.match(JSON.parse(out).err, /нет такого файла/);
  /* обычные запросы на соединении — как раньше, и «get» посреди них — не поток */
  const r = await new Promise(ok => {
    const s = net.createConnection(sock, () => {
      s.write(JSON.stringify({ id: 1, op: 'fs', fop: 'list', path: dir }) + '\n');
      s.write(JSON.stringify({ id: 2, op: 'get', path: path.join(dir, 'f.bin') }) + '\n');
      setTimeout(() => s.end(), 300);
    });
    let b = ''; s.on('data', d => b += d); s.on('end', () => ok(b));
  });
  const msgs = r.trim().split('\n').map(x => JSON.parse(x));
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0].entries.map(e => e.n).sort(), ['f.bin', 'n.txt', 'r.sock']);
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fsOp: поиск с маской не уходит в виртуальные папки и честно говорит о пределе', async () => {
  const r = await fsOp({ fop: 'search', path: '/', q: 'zz-нет-такого-файла-*' });
  assert.equal(r.entries.length, 0);
  assert.ok(!r.entries.some(e => /^\/(proc|sys)\b/.test(e.d)));
  assert.equal(typeof r.partial, 'boolean');
});
