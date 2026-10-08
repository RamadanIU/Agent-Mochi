/* Файловые инструменты агента: read_file, edit_file, write_file и view_image (картинка для модели).
   Работают внутри исполнителя (от имени mochi-agent), как и run_command, — прав у них ровно столько же.
   При полном доступе (root через sudo) то, на что прав не хватило, исполнитель повторяет от root (runner.js).
   Что они берут на себя, чтобы модель не ошибалась и не тратила токены:
   • чтение — с номерами строк и срезами (offset/limit) и подсказкой, откуда продолжить; двоичное не выводится;
   • правка — замена точного фрагмента, который обязан быть единственным; не нашёлся — показываем самое похожее место;
     расхождения только в пробелах по краям строк прощаем (и говорим об этом); несколько правок — все или ни одной;
   • запись — атомарная (временный файл + rename) с сохранением прав, CRLF и BOM; жёсткие ссылки и чужие файлы — на месте;
   • заглушки вместо кода («// ... остальное без изменений») не дают стереть настоящий код;
   • после записи — быстрая проверка синтаксиса (JSON, JS, Python, shell); предупреждаем, только если сломала эта запись.
   Ответ — {text} или {err} (текст без «Ошибка:»), плюс real (настоящий путь) и sig (версия файла) для сервера. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const READ_MAX = 32 * 2 ** 20, EDIT_MAX = 8 * 2 ** 20, IMG_MAX = 8 * 2 ** 20;
const OUT_MAX = 40000, LINE_MAX = 2000, DEF_LIMIT = 1000, DIR_MAX = 200, SNIP = 12, SNIP_LINE = 300;

const soft = m => Object.assign(new Error(m), { soft: true });
const kb = n => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';
const sigOf = st => [st.dev, st.ino, st.size, st.mtimeMs].join(':');
const num = (n, w) => String(n).padStart(w);
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return n + ' ' + (a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many); };
const lines = (a, b) => a === b ? 'строка ' + (a + 1) : `строки ${a + 1}–${b + 1}`;
/* путь для ответа: внутри текущей папки — относительный (короче), иначе абсолютный */
const show = (abs, cwd) => { const r = cwd ? path.relative(cwd, abs) : ''; return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : abs; };
const clip = (s, n) => s.length > n ? s.slice(0, n) + ` …[+${s.length - n} симв.]` : s;

export function resolvePath(p, cwd) {
  p = String(p ?? '').trim();
  if (/^(['"]).+\1$/.test(p)) p = p.slice(1, -1);
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd || os.homedir(), p);
}

/* ---------- текст ---------- */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decode(buf) {
  if (buf.subarray(0, 8192).includes(0)) {
    const u16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
    return { bin: u16 ? 'текст в UTF-16 — сначала сконвертируй в UTF-8: iconv -f UTF-16 -t UTF-8' : 'двоичный файл' };
  }
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, body = bom ? buf.subarray(3) : buf;
  let text, utf8 = true;
  try { text = UTF8.decode(body); } catch { utf8 = false; text = body.toString('utf8'); }
  /* CRLF — только если так оканчиваются все строки; тогда работаем с \n, а при записи возвращаем \r\n */
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
  if (crlf) text = text.replace(/\r\n/g, '\n');
  return { text, bom, crlf, utf8 };
}
const encode = (text, d) => {
  const b = Buffer.from(d.crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  return d.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b;
};
const splitLines = t => { if (!t) return []; const a = t.split('\n'); if (a[a.length - 1] === '') a.pop(); return a; };
const lineStarts = t => { const s = [0]; for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) s.push(i + 1); return s; };
const lineOf = (S, pos) => { let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m] <= pos) lo = m; else hi = m - 1; } return lo; };

/* похожесть строк (коэффициент Дайса по биграммам): 1 — одинаковые */
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const m = new Map();
  for (let i = 0; i < a.length - 1; i++) { const g = a.substr(i, 2); m.set(g, (m.get(g) || 0) + 1); }
  let n = 0;
  for (let i = 0; i < b.length - 1; i++) { const g = b.substr(i, 2), c = m.get(g); if (c) { n++; m.set(g, c - 1); } }
  return 2 * n / (a.length + b.length - 2);
}

/* строки from..to (0-based, включительно) с номерами; длинный кусок — начало и конец */
function snippet(L, from, to) {
  from = Math.max(0, from); to = Math.min(L.length - 1, to);
  if (to < from) return '';
  const w = String(to + 1).length, row = i => num(i + 1, w) + '\t' + clip(L[i], SNIP_LINE), out = [];
  if (to - from + 1 <= SNIP) for (let i = from; i <= to; i++) out.push(row(i));
  else {
    for (let i = from; i < from + SNIP / 2; i++) out.push(row(i));
    out.push(' '.repeat(w) + '\t…');
    for (let i = to - SNIP / 2 + 1; i <= to; i++) out.push(row(i));
  }
  return out.join('\n');
}

/* ---------- файловая система ---------- */
/* открываем без блокировки (FIFO не повесит исполнитель), версия файла — по fstat открытого дескриптора */
async function load(abs, max) {
  const fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (st.isDirectory()) return { st, dir: true };
    if (!st.isFile()) throw soft(`${abs} — не обычный файл (устройство, канал или сокет)`);
    if (st.size > max) return { st, big: true };
    return { st, buf: await fh.readFile() };
  } finally { await fh.close(); }
}

async function notFound(abs, given, cwd) {
  const dir = path.dirname(abs), base = path.basename(abs).toLowerCase(), stem = base.replace(/\.[^.]*$/, '');
  const where = path.isAbsolute(String(given).trim()) || /^~/.test(String(given).trim()) ? '' : ` (путь считается от текущей папки ${cwd})`;
  let names;
  try { names = await fsp.readdir(dir); }
  catch {
    let d = dir; while (d !== path.dirname(d) && !fs.existsSync(d)) d = path.dirname(d);
    return `нет такого файла: ${abs}${where} — нет даже папки ${dir} (ближайшая существующая: ${d})`;
  }
  const sim = names.map(n => { const l = n.toLowerCase(); return [n, l === base ? 3 : l.replace(/\.[^.]*$/, '') === stem ? 2 : dice(l, base)]; })
    .filter(x => x[1] >= 0.6).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]);
  return `нет такого файла: ${abs}${where}` + (sim.length ? `. Похожие в той же папке: ${sim.join(', ')}` : '');
}

async function listDir(abs) {
  const ents = await fsp.readdir(abs, { withFileTypes: true });
  if (!ents.length) return `${abs} — пустая папка`;
  ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return `${abs} — это папка (${ents.length}), а не файл:\n`
    + ents.slice(0, DIR_MAX).map(e => e.name + (e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '')).join('\n')
    + (ents.length > DIR_MAX ? `\n…и ещё ${ents.length - DIR_MAX} (весь список — run_command: ls -la, find)` : '');
}

async function mkParents(dir) {
  let d = dir, made = false;
  while (!fs.existsSync(d) && d !== path.dirname(d)) { made = true; d = path.dirname(d); }
  if (made) await fsp.mkdir(dir, { recursive: true });
  return made;
}

/* атомарно: временный файл рядом + rename (файл никогда не бывает «полузаписан»).
   На месте пишем, если у файла несколько жёстких ссылок или он чужой (rename сменил бы владельца),
   а также если в саму папку писать нельзя, а в файл — можно. */
async function atomicWrite(file, data, st) {
  const mode = st ? st.mode & 0o7777 : 0o666;
  if (!st || (st.nlink < 2 && (!process.getuid || st.uid === process.getuid()))) {
    const tmp = path.join(path.dirname(file), '.' + path.basename(file).slice(0, 100) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
    let fh = null;
    try {
      fh = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
      await fh.writeFile(data);
      await fh.sync();
      if (st) await fh.chmod(mode);
      await fh.close(); fh = null;
      await fsp.rename(tmp, file);
      return;
    } catch (e) {
      if (fh) await fh.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
      if (!st || (e.code !== 'EACCES' && e.code !== 'EPERM')) throw e;
    }
  }
  await fsp.writeFile(file, data);
}

/* ---------- проверка синтаксиса (только предупреждение, на запись не влияет) ---------- */
const CHECK = { '.json': 'json', '.js': 'js', '.mjs': 'esm', '.cjs': 'cjs', '.py': 'py', '.sh': 'sh', '.bash': 'sh' };
const CHECK_NAME = { json: 'JSON', js: 'JavaScript', esm: 'JavaScript', cjs: 'JavaScript', py: 'Python', sh: 'bash' };
const PY = 'import ast,sys\ntry: ast.parse(sys.stdin.buffer.read())\nexcept SyntaxError as e: print(f"line {e.lineno}: {e.msg}"); sys.exit(1)';

/* программа с текстом на stdin → '' (ок), вывод (ошибка) или null (нечем проверить / не успела) */
function check(cmd, args, input) {
  return new Promise(ok => {
    let out = '', done = false, ch;
    const end = v => { if (!done) { done = true; ok(v); } };
    try { ch = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } }); }
    catch { return end(null); }
    ch.stdout.on('data', b => { out += b; }); ch.stderr.on('data', b => { out += b; });
    ch.on('error', () => end(null));
    ch.on('close', code => end(code === 0 ? '' : code == null ? null : out.trim() || 'ошибка'));
    ch.stdin.on('error', () => {});
    ch.stdin.end(input);
  });
}

async function syntax(kind, src) {
  if (!src.trim()) return '';
  if (kind === 'json') {
    try { JSON.parse(src); return ''; }
    catch (e) {
      const m = /position (\d+)/.exec(e.message);
      return (m && !/line \d+/.test(e.message) ? 'line ' + (src.slice(0, +m[1]).split('\n').length) + ': ' : '') + e.message;
    }
  }
  if (kind === 'js' || kind === 'cjs') {
    try { vm.compileFunction(src.replace(/^#!/, '//'), ['exports', 'require', 'module', '__filename', '__dirname'], { filename: 'f' }); return ''; }
    catch (e) {
      if (kind === 'cjs' || !/import|export|await|module/.test(e.message)) return 'line ' + ((/^f:(\d+)/.exec(e.stack || '') || [])[1] || '?') + ': ' + e.message;
    }
  }
  if (kind === 'js' || kind === 'esm') {
    const r = await check(process.execPath, ['--input-type=module', '--check'], src.replace(/^#!/, '//'));
    if (!r) return r ?? '';
    return 'line ' + ((/\[stdin\]:(\d+)/.exec(r) || [])[1] || '?') + ': ' + ((/^\w*Error: .*$/m.exec(r) || [])[0] || r.split('\n')[0]);
  }
  if (kind === 'py') return (await check('python3', ['-c', PY], src)) ?? '';
  if (kind === 'sh') return ((await check('bash', ['-n'], src)) ?? '').replace(/^bash: /gm, '');
  return '';
}

/* предупреждение, только если сломала именно эта запись (до неё файл проверку проходил) */
async function syntaxNote(abs, src, old) {
  const kind = CHECK[path.extname(abs).toLowerCase()];
  if (!kind) return '';
  const e = await syntax(kind, src);
  if (!e) return '';
  if (old != null) { if (await syntax(kind, old)) return ''; }
  /* новый файл: JSON с комментариями (tsconfig и т. п.) и JSX — не ошибки */
  else if (kind === 'json' ? /^\s*(\/\/|\/\*)/m.test(src) : kind === 'js' && /<\/?[A-Za-z][\w.]*[\s/>]/.test(src)) return '';
  return `\n⚠ Файл записан, но в нём ошибка синтаксиса ${CHECK_NAME[kind]}: ${clip(e.split('\n').slice(0, 3).join(' | ').replace(/^line /, 'строка '), 300)}. Исправь.`;
}

/* ---------- заглушки вместо кода ---------- */
const PH_MARK = /^\s*(\/\/|#|\/\*|\*|<!--|--|;|\.\.\.|…|\{\s*\/\*)/, PH_DOTS = /\.\.\.|…/;
const PH_WORDS = /\b(rest of|remaining|existing|unchanged|previous|same as before)\b|остальн|прежн|без изменени|как было|как раньше|и так далее/i;
function placeholder(neu, old) {
  const have = new Set(splitLines(old).map(l => l.trim())), L = splitLines(neu);
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (l.length < 160 && PH_MARK.test(l) && PH_DOTS.test(l) && PH_WORDS.test(l) && !have.has(l.trim())) return { line: i + 1, text: l.trim() };
  }
  return null;
}
const phMsg = (p, whole) => `похоже, вместо кода стоит заглушка — строка ${p.line}: «${clip(p.text, 120)}». ${whole ? 'write_file заменяет файл целиком' : 'edit_file заменяет old_string целиком'}, так что настоящий код пропал бы. Передай полный текст или правь точечно через edit_file. Если это не сокращение, а действительно часть текста, — повтори тот же вызов без изменений.`;

/* ---------- поиск фрагмента для замены ---------- */
const indentOf = s => /^[ \t]*/.exec(s)[0];
const LNUM = /^ *\d+\t/;

/* 0 — точное совпадение; 1 — без учёта пробелов в конце строк; 2 — и в начале (отступы). 1 и 2 — только целыми строками. */
function locate(text, old) {
  const hits = [];
  for (let i = text.indexOf(old); i >= 0; i = text.indexOf(old, i + old.length)) hits.push({ s: i, e: i + old.length });
  if (hits.length) return { hits, mode: 0 };
  const trail = old.endsWith('\n'), ol = (trail ? old.slice(0, -1) : old).split('\n');
  if (!ol.some(l => l.trim())) return { hits, mode: 0 };
  const L = text.split('\n'), S = lineStarts(text);
  for (const mode of [1, 2]) {
    const norm = mode === 1 ? s => s.trimEnd() : s => s.trim(), on = ol.map(norm), fl = L.map(norm);
    for (let i = 0; i + ol.length <= L.length; i++) {
      let k = 0; while (k < ol.length && fl[i + k] === on[k]) k++;
      if (k < ol.length) continue;
      const j = i + ol.length - 1, e = S[j] + L[j].length;
      hits.push({ s: S[i], e: trail && e < text.length ? e + 1 : e, lines: L.slice(i, j + 1) });
      i = j;
    }
    if (hits.length) return { hits, mode, ol };
  }
  return { hits, mode: 0 };
}

/* отступы new_string переводим в отступы файла: как они соотносились в old_string и в файле */
function reindent(fileLines, oldLines, neu) {
  const map = new Map();
  for (let k = 0; k < oldLines.length; k++) {
    if (!oldLines[k].trim()) continue;
    const a = indentOf(oldLines[k]), b = indentOf(fileLines[k]);
    if (map.has(a) && map.get(a) !== b) return neu;
    map.set(a, b);
  }
  if ([...map].every(([a, b]) => a === b)) return neu;
  const keys = [...map.keys()].filter(Boolean).sort((x, y) => y.length - x.length);
  return neu.split('\n').map(l => {
    if (!l.trim()) return l;
    const a = indentOf(l);
    if (map.has(a)) return map.get(a) + l.slice(a.length);
    let rest = a, out = '';
    for (let k; rest && (k = keys.find(x => rest.startsWith(x))) !== undefined;) { out += map.get(k); rest = rest.slice(k.length); }
    if (out) return out + rest + l.slice(a.length);
    return map.has('') ? map.get('') + l : l;
  }).join('\n');
}

/* старая позиция → новая после замен hits (внутри заменённого куска — его начало или конец) */
const mapper = hits => (p, end) => {
  let d = 0;
  for (const h of hits) {
    if (p >= h.e) { d += h.rep.length - (h.e - h.s); continue; }
    if (p > h.s) return h.s + d + (end ? h.rep.length : 0);
    break;
  }
  return p + d;
};

function notFoundMsg(abs, text, old, neu) {
  const S = lineStarts(text);
  if (neu.trim() && text.includes(neu)) return `old_string не найден в ${abs}, а new_string там уже есть (строка ${lineOf(S, text.indexOf(neu)) + 1}) — похоже, эта правка уже сделана.`;
  const L = splitLines(text), ol = old.replace(/\n$/, '').split('\n').map(l => l.trim());
  let k0 = 0; ol.forEach((l, k) => { if (l.length > ol[k0].length) k0 = k; });
  const key = ol[k0];
  let best = -1, score = 0.5;
  if (key && L.length <= 200000) for (let j = 0; j < L.length; j++) {
    const t = L[j].trim();
    if (2 * Math.min(t.length, key.length) / (t.length + key.length || 1) <= score) continue;
    const s = dice(t, key); if (s > score) { score = s; best = j; }
  }
  if (best < 0) return `old_string не найден в ${abs}, и похожих мест нет. Перечитай нужный фрагмент через read_file — возможно, файл уже изменился.`;
  const a = best - k0;
  return `old_string не найден в ${abs}. Самое похожее место:\n${snippet(L, a - 1, a + ol.length)}\nСкопируй old_string оттуда точно — с теми же отступами, но без номеров строк.`;
}

/* ---------- операции ---------- */
async function readOp(q) {
  const abs = resolvePath(q.path, q.cwd), at = show(abs, q.cwd);
  let f;
  try { f = await load(abs, READ_MAX); }
  catch (e) { if (e.code === 'ENOENT') throw soft(await notFound(abs, q.path, q.cwd)); throw e; }
  if (f.dir) return { text: await listDir(abs), real: abs };
  if (f.big) throw soft(`${at} слишком большой (${kb(f.st.size)}) — смотри его частями через run_command: grep -n, sed -n '100,200p', head, tail`);
  const d = decode(f.buf), real = await fsp.realpath(abs), sig = sigOf(f.st);
  if (d.bin) throw soft(imgType(f.buf) ? `${at} — картинка (${kb(f.st.size)}): посмотри её через view_image` : `${at}: ${d.bin} (${kb(f.st.size)}), как текст его не показать. Тип покажет run_command: file; байты — xxd | head`);
  const L = splitLines(d.text), total = L.length;
  if (!total) return { text: `(файл пустой: ${at})`, real, sig, from: 0, to: 0, total };
  const off = parseInt(q.offset, 10) || 0, lim = parseInt(q.limit, 10) || 0;
  let start;
  if (off < 0) start = Math.max(0, total + off);
  else { start = Math.max(1, off) - 1; if (start >= total) throw soft(`в ${at} всего ${total} строк — offset=${off} за концом файла`); }
  const want = lim > 0 ? Math.min(lim, 5000) : DEF_LIMIT, w = String(Math.min(total, start + want)).length, out = [];
  let size = 0, cut = 0, i = start;
  for (; i < total && i < start + want; i++) {
    let l = L[i].replace(/\r$/, '');
    if (l.length > LINE_MAX) { l = clip(l, LINE_MAX); cut++; }
    const s = num(i + 1, w) + '\t' + l;
    if (size + s.length > OUT_MAX && i > start) break;
    out.push(s); size += s.length + 1;
  }
  const notes = [];
  if (start > 0 || i < total) notes.push(`[строки ${start + 1}–${i} из ${total}` + (i < total ? `; дальше — offset=${i + 1}]` : ']'));
  if (cut) notes.push(`[длинные строки (${cut}) обрезаны до ${LINE_MAX} символов — целиком их покажет run_command: cut -c, fold]`);
  if (!d.utf8) notes.push('[файл не в UTF-8: нечитаемые байты заменены на �; edit_file его не правит — сначала сконвертируй: iconv -f CP1251 -t UTF-8]');
  return { text: out.join('\n') + (notes.length ? '\n' + notes.join('\n') : ''), real, sig, from: start + 1, to: i, total };
}

async function editOp(q) {
  const abs = resolvePath(q.path, q.cwd), at = show(abs, q.cwd), edits = Array.isArray(q.edits) ? q.edits : [];
  if (!edits.length) throw soft('нет правок: нужны old_string и new_string (или массив edits)');
  let f;
  try { f = await load(abs, EDIT_MAX); }
  catch (e) { if (e.code === 'ENOENT') throw soft(await notFound(abs, q.path, q.cwd) + '. Новый файл создай через write_file.'); throw e; }
  if (f.dir) throw soft(`${at} — это папка, а не файл`);
  if (f.big) throw soft(`${at} слишком большой для edit_file (${kb(f.st.size)}) — правь через run_command (sed, python)`);
  const d = decode(f.buf);
  if (d.bin) throw soft(`${at}: ${d.bin} — edit_file правит только текст`);
  if (!d.utf8) throw soft(`${at} не в UTF-8 — правка исказила бы его. Сначала сконвертируй: iconv -f CP1251 -t UTF-8 файл > tmp && mv tmp файл`);
  const many = edits.length > 1, notes = new Set();
  let text = d.text, regs = [], count = 0;
  for (let k = 0; k < edits.length; k++) {
    const pre = many ? `правка №${k + 1}: ` : '', post = many ? ' Файл не изменён: исправь эту правку и пришли все заново.' : '';
    const e = edits[k] || {};
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') throw soft(pre + 'old_string и new_string должны быть строками (для удаления new_string — пустая строка)' + post);
    let old = e.old_string, neu = e.new_string;
    if (d.crlf) { old = old.replace(/\r\n/g, '\n'); neu = neu.replace(/\r\n/g, '\n'); }
    if (!old) throw soft(pre + 'old_string пустой. Чтобы вставить текст, возьми в old_string соседнюю строку и повтори её в new_string вместе с новым; файл целиком — write_file.' + post);
    if (old === neu) throw soft(pre + 'old_string и new_string одинаковые — менять нечего' + post);
    let m = locate(text, old);
    /* частая ошибка: скопировала строки вместе с номерами из read_file */
    if (!m.hits.length) {
      const nz = old.split('\n').filter(l => l.trim());
      if (nz.length && nz.every(l => LNUM.test(l))) {
        const strip = s => s.split('\n').map(l => l.replace(LNUM, '')).join('\n');
        const nn = neu.split('\n').filter(l => l.trim());
        const m2 = locate(text, strip(old));
        if (m2.hits.length) { m = m2; old = strip(old); if (nn.length && nn.every(l => LNUM.test(l))) neu = strip(neu); notes.add('номера строк из read_file в old_string убраны — они не часть файла'); }
      }
    }
    if (!m.hits.length) throw soft(pre + notFoundMsg(at, text, old, neu) + post);
    const rall = e.replace_all === true || e.replace_all === 'true';
    if (m.hits.length > 1 && !rall) {
      const S = lineStarts(text), ln = m.hits.slice(0, 15).map(h => lineOf(S, h.s) + 1);
      throw soft(pre + `old_string встречается ${plural(m.hits.length, 'раз', 'раза', 'раз')} (строки ${ln.join(', ')}${m.hits.length > 15 ? ', …' : ''}). Добавь в old_string соседние строки, чтобы место стало единственным, или передай replace_all: true, чтобы заменить все.` + post);
    }
    if (!q.allowPh) { const p = placeholder(neu, old); if (p) return { err: pre + phMsg(p, false) + post, ph: true }; }
    if (m.mode) notes.add(m.mode === 1 ? 'совпадение найдено без учёта пробелов в конце строк' : 'совпадение найдено без учёта отступов — отступы new_string подогнаны под файл, проверь их ниже');
    for (const h of m.hits) h.rep = m.mode === 2 ? reindent(h.lines, m.ol, neu) : neu;
    const mp = mapper(m.hits);
    regs = regs.map(r => ({ s: mp(r.s, false), e: mp(r.e, true) }));
    let out = '', last = 0, delta = 0;
    for (const h of m.hits) {
      out += text.slice(last, h.s) + h.rep; last = h.e;
      regs.push({ s: h.s + delta, e: h.s + delta + h.rep.length });
      delta += h.rep.length - (h.e - h.s);
    }
    text = out + text.slice(last);
    count += m.hits.length;
  }
  if (text === d.text) throw soft('после правок файл не изменился бы — менять нечего');
  await atomicWrite(await fsp.realpath(abs), encode(text, d), f.st);
  const real = await fsp.realpath(abs), st = await fsp.stat(real);
  /* изменённые места → диапазоны строк (соседние склеиваем) */
  const S = lineStarts(text), L = splitLines(text);
  const top = Math.max(0, L.length - 1);
  const rs = regs.map(r => { const a = Math.min(lineOf(S, r.s), top); return { a, b: r.e > r.s ? Math.min(lineOf(S, r.e - 1), top) : a }; }).sort((x, y) => x.a - y.a);
  const ms = [];
  for (const r of rs) { const p = ms[ms.length - 1]; if (p && r.a <= p.b + 3) p.b = Math.max(p.b, r.b); else ms.push({ ...r }); }
  const before = splitLines(d.text).length;
  let res = `Изменён ${at} (${count > 1 ? 'замен: ' + count + '; ' : ''}строк: ${before}${L.length !== before ? ' → ' + L.length : ''}).`;
  if (!L.length) res += ' Файл теперь пустой.';
  else for (const r of ms.slice(0, 3)) res += `\n[${lines(r.a, r.b)}]\n` + snippet(L, r.a - 1, r.b + 1);
  if (ms.length > 3) res += `\n…и ещё ${ms.length - 3} мест: строки ${ms.slice(3, 23).map(r => r.a + 1).join(', ')}${ms.length > 23 ? ', …' : ''}`;
  for (const n of notes) res += `\n[${n}]`;
  res += await syntaxNote(abs, text, d.text);
  return { text: res, real, sig: sigOf(st) };
}

async function writeOp(q) {
  const abs = resolvePath(q.path, q.cwd), at = show(abs, q.cwd), content = String(q.content ?? '');
  let f = null;
  try { f = await load(abs, EDIT_MAX); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (f?.dir) throw soft(`${at} — это папка; укажи путь к файлу`);
  let old = null, made = false;
  if (f) {
    const real = await fsp.realpath(abs), sig = sigOf(f.st), d = f.buf ? decode(f.buf) : null;
    /* непустой файл перезаписываем, только если сервер подтвердил, что агент видел именно эту версию */
    if (f.st.size > 0 && q.expect !== sig) return { need: true, real, sig, size: f.st.size, lines: d && !d.bin ? splitLines(d.text).length : null };
    if (d && !d.bin) old = d.text;
    if (old != null && !q.allowPh) { const p = placeholder(content, old); if (p) return { err: phMsg(p, true), ph: true }; }
    await atomicWrite(real, Buffer.from(content, 'utf8'), f.st);
  } else {
    made = await mkParents(path.dirname(abs));
    await atomicWrite(abs, Buffer.from(content, 'utf8'), null);
  }
  const real = await fsp.realpath(abs), st = await fsp.stat(real), n = splitLines(content).length;
  const res = (f ? `Перезаписан ${at}: строк ${old != null ? splitLines(old).length + ' → ' : ''}${n}` : `Создан ${at}: строк ${n}`)
    + `, ${kb(st.size)}.` + (made ? ` Создана папка ${path.dirname(at)}.` : '');
  return { text: res + await syntaxNote(abs, content, old), real, sig: sigOf(st) };
}

/* ---------- картинка для модели (view_image) ----------
   Формат — по первым байтам, а не по расширению: модели принимают только PNG, JPEG, GIF и WebP. */
function imgType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function imageOp(q) {
  const abs = resolvePath(q.path, q.cwd), at = show(abs, q.cwd);
  let f;
  try { f = await load(abs, IMG_MAX); }
  catch (e) { if (e.code === 'ENOENT') throw soft(await notFound(abs, q.path, q.cwd)); throw e; }
  if (f.dir) throw soft(`${at} — это папка; укажи путь к картинке`);
  if (f.big) throw soft(`${at} слишком большой (${kb(f.st.size)}, можно до ${kb(IMG_MAX)}) — уменьши копию и посмотри её: convert ${at} -resize 2000x2000\\> /tmp/small.jpg`);
  const type = imgType(f.buf);
  if (!type) throw soft(`${at}: не PNG, JPEG, GIF или WebP — модель такое не видит. Сконвертируй в PNG (convert, rsvg-convert для SVG, pdftoppm для PDF) и посмотри копию`);
  return { type, data: f.buf.toString('base64'), size: f.st.size, real: await fsp.realpath(abs), text: `${at} (${kb(f.st.size)})` };
}

function errText(e, q) {
  const p = e.path || resolvePath(q.path, q.cwd);
  switch (e.code) {
    case 'ENOENT': return `нет такого файла или папки: ${p}`;
    case 'EACCES': case 'EPERM': return `нет прав на ${p} (ты работаешь как ${os.userInfo().username}). Владельца и права покажет run_command: ls -la`;
    case 'EISDIR': return `${p} — это папка, а не файл`;
    case 'ENOTDIR': return `часть пути ${p} — файл, а не папка`;
    case 'ENOSPC': return 'на диске закончилось место — файл не записан';
    case 'EROFS': return `${p} на файловой системе только для чтения`;
    case 'ELOOP': return `${p}: зацикленная символическая ссылка`;
    case 'ENAMETOOLONG': return 'слишком длинное имя файла';
    default: return e.message;
  }
}

/* q: {fop: 'read'|'edit'|'write'|'image', path, cwd, ...} */
export async function fileOp(q) {
  q = q || {};
  if (typeof q.path !== 'string' || !q.path.trim()) return { err: 'нет параметра path' };
  try {
    if (q.fop === 'read') return await readOp(q);
    if (q.fop === 'edit') return await editOp(q);
    if (q.fop === 'write') return await writeOp(q);
    if (q.fop === 'image') return await imageOp(q);
    return { err: 'неизвестная операция ' + q.fop };
  } catch (e) {
    /* code — чтобы исполнитель мог повторить от root, если не хватило прав (см. agentFileOp в runner.js) */
    return e.soft ? { err: e.message } : { err: errText(e, q), code: e.code };
  }
}
