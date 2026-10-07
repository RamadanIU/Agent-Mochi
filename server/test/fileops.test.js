/* Файловые инструменты (fileops.js) напрямую: чтение, правка, запись и все защиты от ошибок */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileOp } from '../lib/fileops.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mochi-fileops-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const P = n => path.join(dir, n);
const put = (n, s) => { fs.mkdirSync(path.dirname(P(n)), { recursive: true }); fs.writeFileSync(P(n), s); };
const get = n => fs.readFileSync(P(n), 'utf8');
const op = q => fileOp({ cwd: dir, ...q });
const edit = (n, old_string, new_string, extra = {}) => op({ fop: 'edit', path: n, edits: [{ old_string, new_string, ...extra }] });

test('чтение: номера строк, срезы, хвост и подсказка, откуда продолжить', async () => {
  put('r.txt', Array.from({ length: 30 }, (_, i) => 'строка ' + (i + 1)).join('\n') + '\n');
  const all = await op({ fop: 'read', path: 'r.txt' });
  assert.equal(all.text.split('\n')[0], ' 1\tстрока 1');
  assert.doesNotMatch(all.text, /из 30/);
  assert.equal(all.from, 1); assert.equal(all.to, 30); assert.ok(all.sig && all.real);
  const part = await op({ fop: 'read', path: 'r.txt', offset: 5, limit: 3 });
  assert.equal(part.text, '5\tстрока 5\n6\tстрока 6\n7\tстрока 7\n[строки 5–7 из 30; дальше — offset=8]');
  const tail = await op({ fop: 'read', path: 'r.txt', offset: -2 });
  assert.equal(tail.text, '29\tстрока 29\n30\tстрока 30\n[строки 29–30 из 30]');
  assert.match((await op({ fop: 'read', path: 'r.txt', offset: 99 })).err, /всего 30 строк/);
  /* строковые числа от слабых моделей тоже понимаем */
  assert.equal((await op({ fop: 'read', path: 'r.txt', offset: '2', limit: '1' })).to, 2);
});

test('чтение: пустой файл, папка, двоичный, длинные строки, лимит вывода', async () => {
  put('empty.txt', '');
  assert.match((await op({ fop: 'read', path: 'empty.txt' })).text, /файл пустой/);
  put('d/x.txt', '1'); fs.mkdirSync(P('d/sub'), { recursive: true });
  assert.match((await op({ fop: 'read', path: 'd' })).text, /это папка[^\n]*\nsub\/\nx\.txt/);
  fs.writeFileSync(P('b.bin'), Buffer.from([1, 2, 0, 3]));
  assert.match((await op({ fop: 'read', path: 'b.bin' })).err, /двоичный файл/);
  put('long.txt', 'x'.repeat(5000) + '\nok\n');
  const l = await op({ fop: 'read', path: 'long.txt' });
  assert.match(l.text, /…\[\+3000 симв\.\]/); assert.match(l.text, /2\tok/);
  put('huge.txt', Array.from({ length: 3000 }, () => 'y'.repeat(60)).join('\n'));
  const h = await op({ fop: 'read', path: 'huge.txt' });
  assert.ok(h.text.length < 45000);
  assert.match(h.text, new RegExp(`дальше — offset=${h.to + 1}\\]$`));
});

test('нет файла — подсказка с похожими именами и текущей папкой', async () => {
  put('config.json', '{}');
  const r = await op({ fop: 'read', path: 'Config.jsn' });
  assert.match(r.err, /нет такого файла/);
  assert.match(r.err, /Похожие в той же папке: config\.json/);
  assert.match(r.err, /от текущей папки/);
  assert.match((await op({ fop: 'read', path: 'nope/x.txt' })).err, /нет даже папки/);
});

test('правка: точная замена, сохранение прав, ответ с соседними строками', async () => {
  put('e.sh', '#!/bin/sh\necho один\necho два\necho три\n');
  fs.chmodSync(P('e.sh'), 0o751);
  const r = await edit('e.sh', 'echo два', 'echo ДВА\necho два с половиной');
  assert.equal(get('e.sh'), '#!/bin/sh\necho один\necho ДВА\necho два с половиной\necho три\n');
  assert.equal(fs.statSync(P('e.sh')).mode & 0o777, 0o751);
  assert.match(r.text, /^Изменён e\.sh \(строк: 4 → 5\)\.\n\[строки 3–4\]\n2\techo один\n3\techo ДВА\n4\techo два с половиной\n5\techo три$/);
  /* временных файлов не осталось */
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')), []);
});

test('правка: неоднозначное место, replace_all, уже сделанная правка, пустой old_string', async () => {
  put('m.txt', 'a = 1\nb = 1\nc = 1\n');
  const amb = await edit('m.txt', '= 1', '= 2');
  assert.match(amb.err, /встречается 3 раза \(строки 1, 2, 3\)/);
  assert.equal(get('m.txt'), 'a = 1\nb = 1\nc = 1\n');
  const all = await edit('m.txt', '= 1', '= 2', { replace_all: true });
  assert.match(all.text, /замен: 3/);
  assert.equal(get('m.txt'), 'a = 2\nb = 2\nc = 2\n');
  assert.match((await edit('m.txt', 'a = 1', 'a = 2')).err, /уже есть \(строка 1\) — похоже, эта правка уже сделана/);
  assert.match((await edit('m.txt', '', 'x')).err, /old_string пустой/);
  assert.match((await edit('m.txt', 'a = 2', 'a = 2')).err, /одинаковые/);
  assert.match((await edit('none.txt', 'a', 'b')).err, /нет такого файла.*write_file/);
});

test('правка: не нашлось — показываем самое похожее место', async () => {
  put('s.js', 'function hello(name) {\n  return "Hello, " + name;\n}\n\nfunction bye() {}\n');
  const r = await edit('s.js', 'function hello(user) {\n  return "Hello, " + user;\n}', 'x');
  assert.match(r.err, /old_string не найден в s\.js\. Самое похожее место:\n1\tfunction hello\(name\) \{\n2\t  return "Hello, " \+ name;\n3\t\}/);
  assert.match((await edit('s.js', 'совсем другое', 'x')).err, /похожих мест нет/);
});

test('правка: прощаем номера строк из read_file и расхождения в пробелах (с подгонкой отступов)', async () => {
  put('n.py', 'def f(x):\n\tif x:\n\t\treturn 1\n\treturn 2\n');
  const r1 = await edit('n.py', '2\t\tif x:\n3\t\t\treturn 1', '2\t\tif x > 0:\n3\t\t\treturn 1');
  assert.match(r1.text, /номера строк из read_file в old_string убраны/);
  assert.equal(get('n.py'), 'def f(x):\n\tif x > 0:\n\t\treturn 1\n\treturn 2\n');
  /* модель написала отступы пробелами, а в файле табы */
  const r2 = await edit('n.py', '    if x > 0:\n        return 1\n', '    if x > 0:\n        y = x * 2\n        return y\n');
  assert.match(r2.text, /без учёта отступов/);
  assert.equal(get('n.py'), 'def f(x):\n\tif x > 0:\n\t\ty = x * 2\n\t\treturn y\n\treturn 2\n');
  /* лишние пробелы в конце строк */
  put('t.txt', 'alpha  \nbeta\n');
  const r3 = await edit('t.txt', 'alpha\nbeta', 'ALPHA\nbeta');
  assert.match(r3.text, /без учёта пробелов в конце строк/);
  assert.equal(get('t.txt'), 'ALPHA\nbeta\n');
});

test('правка: несколько правок — по порядку и все или ни одной', async () => {
  put('mm.txt', 'one\ntwo\nthree\n');
  const bad = await op({ fop: 'edit', path: 'mm.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'four', new_string: '4' }] });
  assert.match(bad.err, /^правка №2: old_string не найден[\s\S]*Файл не изменён/);
  assert.equal(get('mm.txt'), 'one\ntwo\nthree\n');
  const ok = await op({ fop: 'edit', path: 'mm.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: '1\ntwo', new_string: '1\n2' }, { old_string: 'three', new_string: '3' }] });
  assert.equal(get('mm.txt'), '1\n2\n3\n');
  assert.match(ok.text, /замен: 3/);
});

test('правка: CRLF, BOM, симлинк и жёсткая ссылка сохраняются', async () => {
  fs.writeFileSync(P('w.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\nc\r\n')]));
  const r = await edit('w.txt', 'a\nb', 'A\nB\nB2');
  assert.ok(r.text, r.err);
  assert.deepEqual(fs.readFileSync(P('w.txt')), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A\r\nB\r\nB2\r\nc\r\n')]));
  put('target.txt', 'x\n'); fs.symlinkSync(P('target.txt'), P('link.txt'));
  await edit('link.txt', 'x', 'y');
  assert.ok(fs.lstatSync(P('link.txt')).isSymbolicLink());
  assert.equal(get('target.txt'), 'y\n');
  put('h1.txt', 'h\n'); fs.linkSync(P('h1.txt'), P('h2.txt'));
  await edit('h1.txt', 'h', 'H');
  assert.equal(get('h2.txt'), 'H\n');
  fs.writeFileSync(P('cp.txt'), Buffer.from([0xcf, 0xf0, 0xe8, 0x0a]));
  assert.match((await edit('cp.txt', 'x', 'y')).err, /не в UTF-8/);
});

test('заглушки вместо кода не стирают файл; повтор с allowPh пропускает', async () => {
  put('ph.js', 'function a() {\n  step1();\n  step2();\n}\n');
  const r = await edit('ph.js', '  step1();\n  step2();', '  step0();\n  // ... rest of code unchanged ...');
  assert.equal(r.ph, true); assert.match(r.err, /заглушка — строка 2/);
  assert.equal(get('ph.js'), 'function a() {\n  step1();\n  step2();\n}\n');
  const w = await op({ fop: 'write', path: 'ph.js', content: 'function a() {\n  // ... остальное без изменений\n}\n', expect: (await op({ fop: 'read', path: 'ph.js' })).sig });
  assert.equal(w.ph, true); assert.match(w.err, /write_file заменяет файл целиком/);
  const ok = await edit('ph.js', '  step1();\n  step2();', '  step0();\n  // ... rest of code unchanged ...', {});
  assert.equal(ok.ph, true);
  const forced = await op({ fop: 'edit', path: 'ph.js', allowPh: true, edits: [{ old_string: '  step2();', new_string: '  // ... rest of code unchanged ...' }] });
  assert.ok(forced.text, forced.err);
  /* обычное многоточие в коде — не заглушка */
  assert.ok((await edit('ph.js', 'step1();', 'log("loading...");')).text);
});

test('запись: создание с папками, перезапись только известной версии', async () => {
  const c = await op({ fop: 'write', path: 'new/deep/f.txt', content: 'привет\nмир\n' });
  assert.match(c.text, /^Создан new\/deep\/f\.txt: строк 2, \d+ Б\. Создана папка new\/deep\.$/);
  assert.equal(get('new/deep/f.txt'), 'привет\nмир\n');
  const need = await op({ fop: 'write', path: 'new/deep/f.txt', content: 'x' });
  assert.equal(need.need, true); assert.equal(need.lines, 2); assert.equal(need.sig, c.sig);
  assert.equal(get('new/deep/f.txt'), 'привет\nмир\n');
  assert.equal((await op({ fop: 'write', path: 'new/deep/f.txt', content: 'x', expect: 'чужая версия' })).need, true);
  const w = await op({ fop: 'write', path: 'new/deep/f.txt', content: 'x\n', expect: c.sig });
  assert.match(w.text, /^Перезаписан new\/deep\/f\.txt: строк 2 → 1/);
  assert.equal(get('new/deep/f.txt'), 'x\n');
  /* пустой файл можно перезаписать без чтения */
  put('e0.txt', '');
  assert.ok((await op({ fop: 'write', path: 'e0.txt', content: 'z' })).text);
  assert.match((await op({ fop: 'write', path: 'new', content: 'z' })).err, /это папка/);
  put('afile', 'q');
  assert.match((await op({ fop: 'write', path: 'afile/x.txt', content: 'z' })).err, /не папка|файл, а не папка/);
});

test('проверка синтаксиса: предупреждаем, только если сломала эта запись', async () => {
  put('c.json', '{"a": 1}\n');
  const bad = await edit('c.json', '"a": 1', '"a": 1,');
  assert.match(bad.text, /⚠ Файл записан, но в нём ошибка синтаксиса JSON/);
  /* файл уже был сломан — новая правка не виновата */
  const still = await edit('c.json', '"a"', '"b"');
  assert.doesNotMatch(still.text, /⚠/);
  const js = await op({ fop: 'write', path: 'x.mjs', content: 'export const a = ;\n' });
  assert.match(js.text, /ошибка синтаксиса JavaScript: строка 1/);
  const cjs = await op({ fop: 'write', path: 'y.js', content: 'const a = require("a");\nmodule.exports = a +;\n' });
  assert.match(cjs.text, /строка 2/);
  assert.doesNotMatch((await op({ fop: 'write', path: 'z.js', content: 'import x from "y";\nexport default x;\n' })).text, /⚠/);
  assert.doesNotMatch((await op({ fop: 'write', path: 'tsconfig.json', content: '{\n  // комментарий\n  "a": 1\n}\n' })).text, /⚠/);
  assert.doesNotMatch((await op({ fop: 'write', path: 'ok.sh', content: '#!/bin/bash\nif true; then echo; fi\n' })).text, /⚠/);
});
