/* Расширения агента: MCP-серверы и навыки (skills). Подключают их и пользователь (настройки), и сам агент (инструменты).
   Главное правило — в контекст модели попадает только нужное:
   • навыки: в системной подсказке только имена; описания и полный текст — по вызову skill;
   • MCP-сервер «по запросу» (по умолчанию): в подсказке одна строка, инструменты появляются после mcp_connect;
   • любой инструмент сервера можно выключить, как и встроенные (см. agent.js).
   Настройки MCP (адреса, заголовки и переменные окружения с ключами) лежат в приватных данных сервера и в браузер не уходят.
   Навыки — папки в рабочей папке пользователя (<папка>/skills/<имя>/SKILL.md), их видит и агент. Сервер читает их
   с проверкой пути (readWork), а пишет только через исполнитель — от имени mochi-agent, без доступа к данным сервера. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CFG } from './config.js';
import { Doc, rid } from './store.js';
import { McpClient, toOpenAI } from './mcp.js';
import { runCmd } from './runner-client.js';
import { userDir, readWork } from './files.js';

const bad = m => Object.assign(new Error(m), { status: 400 });
const oneLine = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const short = (s, n) => { s = oneLine(s, 4000); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const sq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
/* грубая оценка: сколько токенов описание инструмента занимает в каждом запросе к модели */
export const tokens = x => Math.ceil(JSON.stringify(x).length / 3.5);

/* ---------- хранилище ---------- */
const docs = new Map();
function X(u) {
  if (!docs.has(u.id)) docs.set(u.id, new Doc(path.join(CFG.data, 'users', u.id, 'ext.json'), () => ({ mcp: {}, skills: {} })));
  const v = docs.get(u.id).v; v.mcp ||= {}; v.skills ||= {};
  return v;
}
const saveX = u => docs.get(u.id)?.save();
export function dropExt(u) { for (const k of [...pool.keys()]) if (k.startsWith(u.id + '/')) { pool.get(k).c.close(); pool.delete(k); } docs.get(u.id)?.drop(); docs.delete(u.id); }

/* ======================= MCP ======================= */
export const SRV_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/* заголовки / переменные окружения: объект или строки «Имя: значение» / «ИМЯ=значение» */
function kv(x, header) {
  if (x == null || x === '') return {};
  let o = x;
  if (typeof x === 'string') {
    o = {};
    for (const l of x.split(/\r?\n/)) {
      const t = l.trim(); if (!t) continue;
      const m = t.match(header ? /^([^:\s]+)\s*:\s*(.*)$/ : /^([^=\s]+)\s*=\s*(.*)$/);
      if (!m) throw bad('Не поняла строку «' + t.slice(0, 40) + '»: нужно ' + (header ? 'Имя: значение' : 'ИМЯ=значение'));
      o[m[1]] = m[2];
    }
  }
  if (typeof o !== 'object' || Array.isArray(o)) throw bad(header ? 'headers — это объект {"Имя": "значение"}' : 'env — это объект {"ИМЯ": "значение"}');
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (Object.keys(out).length >= 30) throw bad('Слишком много ' + (header ? 'заголовков' : 'переменных'));
    if (header ? !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(k) : !/^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(k) || /^MOCHI_/.test(k)) throw bad('Недопустимое имя: ' + k.slice(0, 40));
    const s = String(v ?? '');
    if (s.length > 4000 || (header && /[\r\n\0]/.test(s))) throw bad('Недопустимое значение для ' + k);
    out[k] = s;
  }
  return out;
}
const transport = s => JSON.stringify([s.type, s.url, s.headers, s.command, s.env]);

/* добавить или изменить сервер; не переданные поля остаются как были */
export function mcpPut(u, b) {
  const name = String(b.name || '').trim().toLowerCase();
  if (!SRV_NAME.test(name)) throw bad('Имя MCP-сервера: латиница в нижнем регистре, цифры, «-» и «_», до 24 символов');
  const all = X(u).mcp, old = all[name];
  if (!old && Object.keys(all).length >= 30) throw bad('Слишком много MCP-серверов (максимум 30)');
  const type = b.type === 'stdio' || b.type === 'http' ? b.type : b.command ? 'stdio' : b.url ? 'http' : old?.type;
  if (!type) throw bad('Укажи адрес (url) HTTP-сервера или команду (command) локального');
  const s = {
    type, url: '', command: '', headers: {}, env: {},
    on: b.on !== undefined ? !!b.on : old?.on ?? true,
    lazy: b.lazy !== undefined ? !!b.lazy : old?.lazy ?? true,
    desc: b.description !== undefined ? oneLine(b.description, 200) : old?.desc || '',
    off: old?.off || [], tools: null, info: null, err: '', t: old?.t || Date.now(),
  };
  if (type === 'http') {
    s.url = b.url !== undefined ? String(b.url).trim() : old?.type === 'http' ? old.url : '';
    if (!/^https?:\/\/[^\s]+$/i.test(s.url) || s.url.length > 2000) throw bad('Адрес MCP-сервера должен начинаться с http:// или https://');
    s.headers = b.headers !== undefined && b.headers !== '' ? kv(b.headers, true) : old?.type === 'http' ? old.headers : {};
  } else {
    s.command = b.command !== undefined ? String(b.command).trim() : old?.type === 'stdio' ? old.command : '';
    if (!s.command || s.command.length > 4000) throw bad('Нужна команда запуска, например: npx -y @modelcontextprotocol/server-memory');
    s.env = b.env !== undefined && b.env !== '' ? kv(b.env, false) : old?.type === 'stdio' ? old.env : {};
  }
  if (old && transport(old) === transport(s)) Object.assign(s, { tools: old.tools, info: old.info, err: old.err });
  else dropClient(u, name);
  all[name] = s; saveX(u);
  return name;
}

export function mcpPatch(u, name, b) {
  const s = X(u).mcp[name]; if (!s) throw bad('Нет MCP-сервера «' + name + '»');
  if (b.on !== undefined) { s.on = !!b.on; if (!s.on) dropClient(u, name); }
  if (b.lazy !== undefined) s.lazy = !!b.lazy;
  if (b.description !== undefined) s.desc = oneLine(b.description, 200);
  if (b.tools && typeof b.tools === 'object') {
    const off = new Set(s.off);
    for (const [t, on] of Object.entries(b.tools)) if (typeof t === 'string' && t.length <= 200) on ? off.delete(t) : off.add(t);
    s.off = [...off].slice(0, 500);
  }
  saveX(u);
}

export function mcpDel(u, name) {
  if (!X(u).mcp[name]) throw bad('Нет MCP-сервера «' + name + '»');
  dropClient(u, name); delete X(u).mcp[name]; saveX(u);
}

/* открытые соединения: по одному на сервер пользователя; простаивающие закрываем (stdio-процессы — тоже) */
const pool = new Map();
function client(u, name) {
  const s = X(u).mcp[name]; if (!s) throw bad('Нет MCP-сервера «' + name + '»');
  const k = u.id + '/' + name, sig = transport(s);
  let p = pool.get(k);
  if (p && p.sig !== sig) { p.c.close(); p = null; }
  if (!p) pool.set(k, p = { c: new McpClient({ ...s, cwd: userDir(u) }), sig, fail: 0 });
  return p;
}
function dropClient(u, name) { const k = u.id + '/' + name; pool.get(k)?.c.close(); pool.delete(k); }
setInterval(() => { for (const [k, p] of pool) if (Date.now() - p.c.used > 15 * 60e3) { p.c.close(); pool.delete(k); } }, 60e3).unref();

/* (пере)подключиться и запомнить список инструментов — дальше подсказка строится без соединения */
export async function mcpRefresh(u, name, ms = 30000) {
  const p = client(u, name), s = X(u).mcp[name];
  p.c.close();
  try {
    const tools = await p.c.connect(ms);
    s.tools = tools.slice(0, 300).map(t => ({ name: t.name, description: String(t.description || t.title || '').slice(0, 1500), inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} } }));
    s.info = p.c.info; s.err = ''; p.fail = 0;
    return s.tools;
  } catch (e) { s.err = String(e.message).slice(0, 300); p.fail = Date.now(); throw e; }
  finally { saveX(u); }
}
async function ensureTools(u, name) {
  const s = X(u).mcp[name];
  if (s.tools) return s.tools;
  const p = client(u, name);
  if (p.fail && Date.now() - p.fail < 60e3) return null;
  try { return await mcpRefresh(u, name, 20000); } catch { return null; }
}

/* имя функции для модели: сервер__инструмент (OpenAI: [A-Za-z0-9_-], до 64 символов) */
export function fnName(srv, tool) {
  const n = (srv + '__' + tool).replace(/[^A-Za-z0-9_-]/g, '_');
  return n.length <= 64 ? n : n.slice(0, 55) + '_' + crypto.createHash('sha1').update(srv + '/' + tool).digest('hex').slice(0, 8);
}

export async function mcpCall(u, { srv, tool }, args, signal) {
  const p = client(u, srv);
  try { return await p.c.call(tool, args, signal, 300000); }
  catch (e) { if (signal?.aborted) throw e; return 'Ошибка MCP-сервера «' + srv + '»: ' + e.message; }
}

const maskUrl = s => { try { const x = new URL(s); return x.origin + x.pathname + (x.search ? '?…' : ''); } catch { return ''; } };
export function mcpPublic(u) {
  return Object.entries(X(u).mcp).map(([name, s]) => ({
    name, type: s.type, url: s.type === 'http' ? maskUrl(s.url) : '', command: s.command, headers: Object.keys(s.headers || {}), env: Object.keys(s.env || {}),
    on: s.on, lazy: s.lazy, desc: s.desc, err: s.err, server: s.info?.name || '', known: !!s.tools,
    tools: (s.tools || []).map(t => ({ name: t.name, desc: short(t.description, 160), on: !s.off.includes(t.name), size: tokens(toOpenAI(t, fnName(name, t.name))) })),
  }));
}

/* ======================= навыки ======================= */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const normSkill = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
export const skillsRoot = u => path.join(userDir(u), 'skills');

/* YAML-заголовок SKILL.md — только простые «ключ: значение» (и многострочные значения с отступом) */
export function frontmatter(txt) {
  const t = String(txt || '').replace(/^﻿/, '');
  const m = t.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { body: t };
  const o = {}; let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1]; let v = kv[2].trim();
      if (/^[>|][-+]?$/.test(v)) v = '';
      else if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      o[key] = v; continue;
    }
    if (key && /^\s+\S/.test(line)) o[key] = (o[key] ? o[key] + ' ' : '') + line.trim();
  }
  o.body = t.slice(m[0].length);
  return o;
}

export async function skillList(u) {
  const root = skillsRoot(u), on = X(u).skills;
  let ents; try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of ents) {
    if (out.length >= 200) break;
    if (!SKILL_DIR.test(d.name) || !(d.isDirectory() || d.isSymbolicLink())) continue;
    const txt = await readWork(path.join(root, d.name, 'SKILL.md'), 16384);
    if (txt == null) continue;
    const fm = frontmatter(txt);
    out.push({ name: d.name, title: fm.name && fm.name !== d.name ? oneLine(fm.name, 64) : '', desc: oneLine(fm.description, 1024), on: on[d.name] !== false });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function skillRaw(u, name) {
  if (!SKILL_DIR.test(name)) return null;
  return readWork(path.join(skillsRoot(u), name, 'SKILL.md'), 256 * 1024);
}

/* файлы навыка (скрипты, шаблоны, справка) — чтобы агент знал, что можно прочитать или запустить */
async function skillFiles(dir) {
  const out = [];
  const walk = async (d, rel, depth) => {
    let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 60) return;
      if (e.name.startsWith('.') || (!rel && e.name === 'SKILL.md')) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (depth < 3) await walk(path.join(d, e.name), r, depth + 1); } else if (e.isFile()) out.push(r);
    }
  };
  await walk(dir, '', 0);
  return out;
}

async function useSkill(u, name) {
  if (!name) { const l = (await skillList(u)).filter(k => k.on); return l.length ? l.map(k => k.name + ' — ' + (short(k.desc, 300) || 'без описания')).join('\n') : 'Навыков нет.'; }
  const all = await skillList(u), k = all.find(x => x.name === name) || all.find(x => x.name === normSkill(name) || x.title === name);
  if (!k) return 'Ошибка: нет навыка «' + name + '». Есть: ' + (all.filter(x => x.on).map(x => x.name).join(', ') || '—');
  if (!k.on) return 'Ошибка: навык «' + k.name + '» выключен';
  const dir = path.join(skillsRoot(u), k.name);
  const real = await fsp.realpath(dir).catch(() => null), work = await fsp.realpath(CFG.work).catch(() => path.resolve(CFG.work));
  const txt = await readWork(path.join(dir, 'SKILL.md'), 256 * 1024);
  if (txt == null || !real || !real.startsWith(work + path.sep)) return 'Ошибка: не получилось прочитать навык «' + k.name + '»';
  let body = frontmatter(txt).body.trim();
  if (body.length > 40000) body = body.slice(0, 40000) + '\n…(усечено; полный текст: ' + path.join(dir, 'SKILL.md') + ')';
  const files = await skillFiles(dir);
  return 'Навык «' + k.name + '». Папка навыка: ' + dir + ' — пути в инструкции считай от неё.'
    + (files.length ? '\nФайлы навыка (читай и запускай через run_command, когда понадобятся): ' + files.join(', ') : '')
    + '\n\n' + body;
}

/* записать SKILL.md (от имени агента). b: {name, raw} — готовый файл, или {name, description, instructions} */
export async function skillWrite(u, b) {
  const name = normSkill(b.name);
  if (!SKILL_NAME.test(name)) throw bad('Имя навыка: латиница в нижнем регистре, цифры и «-», до 64 символов');
  let md;
  if (typeof b.raw === 'string') {
    md = b.raw.replace(/\r\n/g, '\n');
    if (!oneLine(frontmatter(md).description, 10)) throw bad('В начале SKILL.md нужен заголовок:\n---\nname: ' + name + '\ndescription: когда применять навык\n---');
  } else {
    const desc = oneLine(b.description, 1024), body = String(b.instructions ?? '').trim();
    if (!desc) throw bad('Нужно описание навыка: когда его применять');
    if (!body) throw bad('Нужен текст инструкции');
    md = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body}\n`;
  }
  if (Buffer.byteLength(md) > 60000) throw bad('Инструкция слишком длинная (максимум ~60 КБ). Большие материалы положи отдельными файлами в папку навыка.');
  const d = path.join(skillsRoot(u), name), f = d + '/SKILL.md';
  const r = await runCmd({ cmd: `set -e\nmkdir -p ${sq(d)}\nprintf %s ${sq(Buffer.from(md).toString('base64'))} | base64 -d > ${sq(f + '.tmp')}\nmv -f ${sq(f + '.tmp')} ${sq(f)}`, cwd: userDir(u), timeout: 30 });
  if (r.code !== 0) throw bad('Не получилось записать навык: ' + String(r.out).slice(0, 300));
  delete X(u).skills[name]; saveX(u);
  return name;
}

/* ссылка → git-репозиторий: github.com/владелец/репо[/tree|blob/ветка/путь] или https://….git */
function parseGit(s) {
  const m = s.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:\/(tree|blob)\/([^/\s]+)(?:\/(\S*?))?)?\/?$/);
  if (m) {
    let sub = decodeURIComponent(m[5] || '');
    if (m[3] === 'blob') sub = /(^|\/)SKILL\.md$/i.test(sub) ? path.posix.dirname(sub) : sub;
    if (sub === '.') sub = '';
    return { repo: `https://github.com/${m[1]}/${m[2]}.git`, ref: m[4] || '', sub, name: m[2] };
  }
  if (/^https:\/\/\S+\.git$/i.test(s)) return { repo: s, ref: '', sub: '', name: path.posix.basename(s, '.git') };
  return null;
}

/* установить навык(и) по ссылке; want — имя (если в репозитории несколько навыков — только этот) */
export async function skillInstall(u, src, want) {
  src = String(src || '').trim();
  if (!/^https?:\/\/\S+$/i.test(src)) throw bad('Нужна ссылка: папка или репозиторий на GitHub, или прямой URL на SKILL.md');
  const g = parseGit(src);
  if (!g) {
    const r = await fetch(src, { signal: AbortSignal.timeout(20000) }).catch(e => { throw bad('Не скачалось: ' + (e.cause?.code || e.message)); });
    if (!r.ok) throw bad('Не скачалось: HTTP ' + r.status);
    const txt = (await r.text()).slice(0, 200000), fm = frontmatter(txt);
    if (!fm.description) throw bad('По ссылке не SKILL.md: нет заголовка с description');
    let fallback = ''; try { fallback = path.posix.basename(path.posix.dirname(new URL(src).pathname)); } catch {}
    return [await skillWrite(u, { name: want || fm.name || fallback, raw: txt })];
  }
  if (g.sub.split('/').includes('..')) throw bad('Неверный путь в ссылке');
  const tmp = path.join(userDir(u), '.skill-' + rid(6)), base = tmp + (g.sub ? '/' + g.sub : '');
  const clean = () => runCmd({ cmd: 'rm -rf ' + sq(tmp), cwd: userDir(u), timeout: 60 }).catch(() => {});
  try {
    const r = await runCmd({ cmd: [
      'set -e', 'command -v git >/dev/null || { echo "на сервере нет git"; exit 3; }',
      `git clone -q --depth 1 ${g.ref ? '--branch ' + sq(g.ref) + ' ' : ''}${g.sub ? '--filter=blob:none --sparse ' : ''}${sq(g.repo)} ${sq(tmp)}`,
      g.sub ? `git -C ${sq(tmp)} sparse-checkout set ${sq(g.sub)}` : 'true',
      `cd ${sq(base)}`, `find . -maxdepth 4 -name SKILL.md -not -path '*/.git/*' | sort | head -50 | sed 's/^/@F /'`,
    ].join('\n'), cwd: userDir(u), timeout: 300 });
    const found = [...String(r.out).matchAll(/^@F \.\/(.*?)\/?SKILL\.md$/gm)].map(x => x[1]);
    if (r.code !== 0 || !found.length) throw bad(r.code !== 0 ? 'Не скачалось: ' + String(r.out).replace(/\[код выхода.*$/s, '').trim().slice(-300) : 'В этой папке нет SKILL.md');
    const top = found.includes('') ? [''] : found;
    let items = top.map(rel => ({ rel, name: normSkill(rel ? path.posix.basename(rel) : want || path.posix.basename(g.sub) || g.name) }));
    if (want && items.length > 1) items = items.filter(i => i.name === normSkill(want));
    items = items.filter((i, k) => SKILL_NAME.test(i.name) && items.findIndex(j => j.name === i.name) === k);
    if (!items.length) throw bad(want ? 'Навыка «' + want + '» в репозитории нет. Есть: ' + found.map(f => path.posix.basename(f)).join(', ') : 'Не нашла навыков с подходящими именами');
    const root = skillsRoot(u);
    const c = await runCmd({ cmd: ['set -e', `mkdir -p ${sq(root)}`, ...items.map(i => `rm -rf ${sq(root + '/' + i.name)} && cp -R ${sq(base + (i.rel ? '/' + i.rel : ''))} ${sq(root + '/' + i.name)} && rm -rf ${sq(root + '/' + i.name + '/.git')}`)].join('\n'), cwd: userDir(u), timeout: 120 });
    if (c.code !== 0) throw bad('Не получилось скопировать навык: ' + String(c.out).slice(0, 300));
    for (const i of items) delete X(u).skills[i.name];
    saveX(u);
    return items.map(i => i.name);
  } finally { await clean(); }
}

export async function skillSet(u, name, on) {
  if (!(await skillList(u)).some(k => k.name === name)) throw bad('Нет навыка «' + name + '»');
  if (on) delete X(u).skills[name]; else X(u).skills[name] = false;
  saveX(u);
}

export async function skillDel(u, name) {
  if (!SKILL_DIR.test(name) || !(await skillList(u)).some(k => k.name === name)) throw bad('Нет навыка «' + name + '»');
  const r = await runCmd({ cmd: 'rm -rf -- ' + sq(path.join(skillsRoot(u), name)), cwd: userDir(u), timeout: 60 });
  if (r.code !== 0) throw bad('Не получилось удалить: ' + String(r.out).slice(0, 200));
  delete X(u).skills[name]; saveX(u);
}

/* ======================= инструменты для модели ======================= */
const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required ? { required } : {}) } } });
const S = description => ({ type: 'string', description });
const SKILL_TOOL = fn('skill', 'Загрузить полную инструкцию навыка из списка «Навыки» и следовать ей. Вызывай до начала задачи, к которой навык может подойти. Без name — список навыков с описаниями.', { name: S('Имя навыка из списка') });
const CONNECT_TOOL = fn('mcp_connect', 'Подключить инструменты MCP-сервера из списка «MCP-серверы по запросу» — они появятся со следующего шага.', { server: S('Имя сервера из списка') }, ['server']);
export const MANAGE_TOOLS = [
  fn('mcp_manage', 'MCP-серверы — внешние инструменты. list — список и состояние; add — подключить или изменить сервер (HTTP: url и, если нужен ключ, headers; локальный: command, например «npx -y @modelcontextprotocol/server-memory», и env); enable/disable; remove. Ключи сохраняются в защищённых данных сервера.', {
    action: { type: 'string', enum: ['list', 'add', 'enable', 'disable', 'remove'] },
    name: S('Имя сервера: латиница, цифры, «-», «_»'),
    url: S('add, HTTP: адрес, например https://example.com/mcp'),
    headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'add, HTTP: заголовки, например {"Authorization": "Bearer …"}' },
    command: S('add, локальный: команда запуска stdio-сервера'),
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'add, локальный: переменные окружения (ключи API)' },
    lazy: { type: 'boolean', description: 'add: true (по умолчанию) — инструменты подключаются по запросу через mcp_connect и не занимают память; false — всегда' },
    description: S('add: коротко, для чего сервер'),
  }, ['action']),
  fn('skills_manage', 'Навыки (skills) — папки с инструкцией SKILL.md. list; install — установить по ссылке (папка или репозиторий GitHub, прямой URL на SKILL.md); create — создать или переписать свой навык; enable/disable; remove.', {
    action: { type: 'string', enum: ['list', 'install', 'create', 'enable', 'disable', 'remove'] },
    name: S('Имя навыка: латиница в нижнем регистре, цифры, «-»'),
    url: S('install: ссылка'),
    description: S('create: когда применять навык — одна строка, по ней потом решается, загружать ли его'),
    instructions: S('create: текст инструкции (Markdown)'),
  }, ['action']),
];
export const EXT_TOOLS = new Set(['skill', 'mcp_connect', 'mcp_manage', 'skills_manage']);

/* для очередного шага агента: инструменты расширений и строки для системной подсказки */
export async function agentExt(chat, off = {}) {
  const u = chat.u, act = chat.doc.v.act || [], defs = [], route = new Map(), lazy = [], down = [];
  const srvs = Object.entries(X(u).mcp).filter(([, s]) => s.on);
  await Promise.all(srvs.map(async ([name, s]) => {
    if (s.lazy && !act.includes(name)) return;
    if (!await ensureTools(u, name)) down.push(name);
  }));
  for (const [name, s] of srvs) {
    if (s.lazy && !act.includes(name)) {
      const n = s.tools ? s.tools.filter(t => !s.off.includes(t.name)).length : 0;
      if (!s.tools || n) lazy.push(name + (s.desc || s.info?.name ? ' — ' + short(s.desc || s.info.name, 80) : '') + (n ? ' (' + n + ')' : ''));
      continue;
    }
    for (const t of s.tools || []) {
      if (s.off.includes(t.name)) continue;
      const f = fnName(name, t.name); defs.push(toOpenAI(t, f)); route.set(f, { srv: name, tool: t.name });
    }
  }
  const skills = (await skillList(u)).filter(k => k.on);
  if (skills.length) defs.push(SKILL_TOOL);
  if (lazy.length) defs.push(CONNECT_TOOL);
  for (const t of MANAGE_TOOLS) if (off[t.function.name] !== false) defs.push(t);
  /* навыки — только имена: описания и текст модель берёт через skill, когда нужно */
  const prompt = (skills.length ? '\nНавыки (готовые инструкции; если задача может подойти — загрузи навык через skill): ' + skills.map(k => k.name).join(', ') + '.' : '')
    + (lazy.length ? '\nMCP-серверы по запросу (их инструменты подключает mcp_connect): ' + lazy.join('; ') + '.' : '')
    + (down.length ? '\nMCP-серверы сейчас не отвечают: ' + down.join(', ') + '.' : '');
  return { defs, route, prompt };
}

function scrubSecrets(chat, o) {
  for (const v of Object.values(o || {})) {
    const s = String(v);
    for (const x of [s, s.replace(/^\S+\s+/, '')]) if (x.length >= 12) chat.scrub(x, '[секрет сохранён на сервере]');
  }
}
const srvLine = (name, s) => name + ': ' + (s.on ? 'включён' : 'выключен') + ', ' + (s.lazy ? 'по запросу' : 'всегда') + ', '
  + (s.type === 'http' ? maskUrl(s.url) : 'команда «' + short(s.command, 80) + '»')
  + (s.tools ? ', инструментов: ' + s.tools.length + (s.off.length ? ' (выключено ' + s.off.length + ')' : '') : '') + (s.err ? ', ошибка: ' + s.err : '') + (s.desc ? ' — ' + s.desc : '');

export async function extTool(chat, nm, a) {
  const u = chat.u, name = String(a.name || a.server || '').trim();
  if (nm === 'skill') return useSkill(u, name);
  if (nm === 'mcp_connect') {
    const key = name.toLowerCase(), s = X(u).mcp[key];
    if (!s || !s.on) return 'Ошибка: нет включённого MCP-сервера «' + name + '»';
    try { if (!s.tools) await mcpRefresh(u, key); } catch (e) { return 'Ошибка: сервер «' + key + '» не подключился: ' + e.message; }
    const act = chat.doc.v.act ||= [];
    if (!act.includes(key)) act.push(key);
    chat.doc.save();
    const on = s.tools.filter(t => !s.off.includes(t.name));
    return 'Подключила «' + key + '»: ' + (on.map(t => fnName(key, t.name)).join(', ') || 'инструментов нет') + '. Они доступны со следующего шага.' + (s.info?.instructions ? '\nПодсказка сервера: ' + s.info.instructions : '');
  }
  const act = String(a.action || '');
  if (nm === 'mcp_manage') {
    const all = X(u).mcp, key = name.toLowerCase();
    if (act === 'list') return Object.keys(all).length ? Object.entries(all).map(([n, s]) => srvLine(n, s)).join('\n') : 'MCP-серверов нет.';
    if (act === 'add') {
      const b = { name: key, url: a.url, command: a.command, lazy: a.lazy, description: a.description };
      if (a.headers !== undefined) b.headers = a.headers;
      if (a.env !== undefined) b.env = a.env;
      const n = mcpPut(u, b);
      scrubSecrets(chat, a.headers); scrubSecrets(chat, a.env);
      let tools;
      try { tools = await mcpRefresh(u, n); } catch (e) { return 'Сервер «' + n + '» сохранён, но не подключился: ' + e.message + '. Проверь адрес или команду и вызови add ещё раз.'; }
      if (all[n].lazy) { const ac = chat.doc.v.act ||= []; if (!ac.includes(n)) ac.push(n); chat.doc.save(); }
      return 'Сервер «' + n + '» подключён, инструментов: ' + tools.length + ' (' + tools.map(t => fnName(n, t.name)).slice(0, 40).join(', ') + '). Они доступны со следующего шага.';
    }
    if (act === 'enable' || act === 'disable') { mcpPatch(u, key, { on: act === 'enable' }); return 'Сервер «' + key + '» ' + (act === 'enable' ? 'включён' : 'выключен') + '.'; }
    if (act === 'remove') { mcpDel(u, key); return 'Сервер «' + key + '» удалён.'; }
    return 'Ошибка: неизвестное действие ' + act;
  }
  if (nm === 'skills_manage') {
    if (act === 'list') { const l = await skillList(u); return l.length ? 'Папка навыков: ' + skillsRoot(u) + '\n' + l.map(k => k.name + (k.on ? '' : ' (выключен)') + (k.desc ? ' — ' + short(k.desc, 160) : '')).join('\n') : 'Навыков нет. Папка для них: ' + skillsRoot(u); }
    if (act === 'install') { const l = await skillInstall(u, a.url, name || undefined); return 'Установлено: ' + l.join(', ') + '. Загружай через skill, когда понадобится.'; }
    if (act === 'create') { const n = await skillWrite(u, { name, description: a.description, instructions: a.instructions }); return 'Навык «' + n + '» сохранён: ' + path.join(skillsRoot(u), n, 'SKILL.md') + '. Дополнительные файлы можно положить в его папку.'; }
    if (act === 'enable' || act === 'disable') { await skillSet(u, name, act === 'enable'); return 'Навык «' + name + '» ' + (act === 'enable' ? 'включён' : 'выключен') + '.'; }
    if (act === 'remove') { await skillDel(u, name); return 'Навык «' + name + '» удалён.'; }
    return 'Ошибка: неизвестное действие ' + act;
  }
  return 'Ошибка: неизвестный инструмент ' + nm;
}
