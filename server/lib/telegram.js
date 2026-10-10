/* Telegram: у каждого пользователя может быть свой бот.
   • Подключение: токен от @BotFather (через инструмент агента telegram_connect или настройки) →
     одноразовая ссылка t.me/<бот>?start=<код> (30 минут) → бот принимает команды только из привязанного чата.
   • Управление: обычные сообщения/файлы → задача для Мочи (во время работы — дополнение к ней); /status, /stop, /now, /new, /help.
   • Уведомления: по окончании задачи (режим away — только когда чат в браузере закрыт). */
import path from 'node:path';
import crypto from 'node:crypto';
import { CFG } from './config.js';
import { Doc, rid } from './store.js';
import { getChat, hooks } from './agent.js';
import { putInbox, storeCopy, sz } from './files.js';

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const LINK_TTL = 30 * 60e3;
const bots = new Map(); /* uid → Bot */
let usersFn = () => [];

const tgDoc = u => new Doc(path.join(CFG.data, 'users', u.id, 'telegram.json'), {});
const docs = new Map();
const conf = u => { if (!docs.has(u.id)) docs.set(u.id, tgDoc(u)); return docs.get(u.id); };

async function api(token, method, params = {}, signal, form) {
  const r = await fetch(`${CFG.tgApi}/bot${token}/${method}`, form
    ? { method: 'POST', body: form, signal }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal });
  let j; try { j = await r.json(); } catch { j = { ok: false, description: 'HTTP ' + r.status }; }
  if (!j.ok) throw Object.assign(new Error(j.description || 'ошибка Telegram'), { code: j.error_code, retry: j.parameters?.retry_after });
  return j.result;
}

const chunks = (t, n = 4000) => { const out = []; t = String(t || ''); while (t.length > n) { let k = t.lastIndexOf('\n', n); if (k < n / 2) k = n; out.push(t.slice(0, k)); t = t.slice(k); } if (t.trim()) out.push(t); return out; };
const plain = t => String(t || '').replace(/```[\w+.#-]*\n?/g, '').replace(/\*\*([^*\n]+)\*\*/g, '$1');
const dur = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + ' с' : Math.floor(s / 60) + ' мин ' + (s % 60) + ' с'; };

class Bot {
  constructor(u) {
    this.u = u; this.c = conf(u); this.ac = null; this.off = +this.c.v.off || 0; this.status = null; this.lastEdit = 0; this.editT = null; this.warned = new Set();
  }
  get v() { return this.c.v; }
  send(text, extra = {}) { return api(this.v.token, 'sendMessage', { chat_id: this.v.chatId, text, disable_web_page_preview: true, ...extra }); }
  async say(text) { if (!this.v.chatId) return; for (const p of chunks(plain(text))) await this.send(p).catch(e => console.warn('tg send:', e.message)); }
  async doc(name, data, caption) {
    if (!this.v.chatId) return;
    const f = new FormData();
    f.append('chat_id', String(this.v.chatId));
    if (caption) f.append('caption', String(caption).slice(0, 1000));
    f.append('document', new Blob([data]), name);
    await api(this.v.token, 'sendDocument', {}, undefined, f).catch(e => console.warn('tg doc:', e.message));
  }

  start() {
    if (this.ac) return;
    this.ac = new AbortController();
    this.poll(this.ac.signal);
    this.watch();
  }
  stop() { this.ac?.abort(); this.ac = null; this.unwatch?.(); this.unwatch = null; }

  async poll(signal) {
    let back = 1000, hooked = false;
    while (!signal.aborted) {
      try {
        const ups = await api(this.v.token, 'getUpdates', { offset: this.off, timeout: 50, allowed_updates: ['message'] }, AbortSignal.any([signal, AbortSignal.timeout(65000)]));
        back = 1000;
        /* offset на диск до обработки: после перезапуска старые сообщения не выполнятся повторно */
        for (const up of ups) { this.off = this.v.off = up.update_id + 1; this.c.flush(); await this.onUpdate(up).catch(e => console.warn('tg update:', e.message)); }
      } catch (e) {
        if (signal.aborted) return;
        if (e.code === 401 || e.code === 404) { this.v.error = 'Telegram отклонил токен (бот удалён или токен сменён)'; this.c.save(); this.stop(); return; }
        if (e.code === 409 && !hooked) { hooked = true; await api(this.v.token, 'deleteWebhook', {}).catch(() => {}); continue; }
        await new Promise(ok => setTimeout(ok, e.retry ? e.retry * 1000 : back));
        back = Math.min(back * 2, 60000);
      }
    }
  }

  async onUpdate(up) {
    const m = up.message;
    if (!m || m.chat?.type !== 'private' || !m.from || m.from.is_bot) return;
    const v = this.v, txt = String(m.text || m.caption || '').trim();
    const st = txt.match(/^\/start(?:@\w+)?\s+(\S+)/);
    if (st) {
      const ok = v.link && v.linkExp > Date.now() && st[1].length === v.link.length && crypto.timingSafeEqual(Buffer.from(st[1]), Buffer.from(v.link));
      if (!ok) { await api(v.token, 'sendMessage', { chat_id: m.chat.id, text: 'Ссылка не подошла или устарела. Попроси Мочи выдать новую (в чате: «дай новую ссылку для Telegram»).' }); return; }
      Object.assign(v, { chatId: m.chat.id, tgUser: m.from.username || m.from.first_name || String(m.from.id), link: null, linkExp: 0, error: null });
      this.c.save();
      await this.send(`✅ Готово! Теперь я, Мочи, слушаюсь тебя здесь (аккаунт на сервере: ${this.u.name}).\n\nПросто пиши задачи или присылай файлы. Команды: /status, /stop, /new, /help`);
      getChat(this.u).push({ kind: 'note', text: 'Telegram привязан: @' + v.tgUser });
      return;
    }
    if (m.chat.id !== v.chatId) {
      if (!this.warned.has(m.chat.id) && this.warned.size < 100) { this.warned.add(m.chat.id); await api(v.token, 'sendMessage', { chat_id: m.chat.id, text: 'Это личный бот. Доступ только у владельца.' }).catch(() => {}); }
      return;
    }
    const chat = getChat(this.u), cmd = (txt.match(/^\/(\w+)/) || [])[1];
    if (cmd === 'help' || cmd === 'start') return this.send('Я Мочи — агент на твоём сервере 🐾\nПиши задачу обычным сообщением, присылай файлы и фото. Пока я работаю, можно дописать или спросить — прочту по ходу дела.\n\n/status — что я сейчас делаю\n/stop — остановить задачу\n/now — прочитать новые сообщения сейчас, не дожидаясь конца шага\n/new — очистить чат\n/web — ссылка на веб-чат\n/notify — уведомления (away/always/off)');
    if (cmd === 'status') {
      const r = chat.runState(), last = [...chat.doc.v.log].reverse().find(e => e.kind === 'tool');
      return this.send(r.running ? `⏳ Работаю уже ${dur(Date.now() - r.t)}, шагов: ${r.steps}.${last ? '\nСейчас: ' + last.label : ''}` : '😴 Свободна. Жду задачу!');
    }
    if (cmd === 'stop') { if (chat.running) { chat.stop(); return this.send('⏹ Останавливаю…'); } return this.send('Я и так ничего не делаю ^_^'); }
    if (cmd === 'now') return this.send(chat.hurry() ? '⚡ Бросаю текущий шаг и читаю твои сообщения' : chat.running ? 'Новых сообщений нет — продолжаю работу' : 'Я и так ничего не делаю ^_^');
    if (cmd === 'new') { chat.clear(); return this.send('🧹 Чат очищен.'); }
    if (cmd === 'web') return this.send(CFG.publicUrl ? CFG.publicUrl + '/' : 'Адрес веб-чата не задан (MOCHI_PUBLIC_URL).');
    if (cmd === 'notify') {
      const mode = (txt.split(/\s+/)[1] || '').toLowerCase();
      if (!['away', 'always', 'off'].includes(mode)) return this.send('Сейчас: ' + (v.notify || 'away') + '\n/notify away — когда веб-чат закрыт\n/notify always — всегда\n/notify off — никогда');
      v.notify = mode; this.c.save(); return this.send('Готово: ' + mode);
    }
    /* файлы и фото → inbox */
    const files = [];
    const fobj = m.document || (m.photo && m.photo[m.photo.length - 1]) || m.audio || m.voice || m.video;
    if (fobj) {
      try {
        if (fobj.file_size > 20 * 2 ** 20) throw new Error('Telegram отдаёт ботам файлы только до 20 МБ — загрузи его через веб-чат');
        const f = await api(v.token, 'getFile', { file_id: fobj.file_id });
        const r = await fetch(`${CFG.tgApi}/file/bot${v.token}/${f.file_path}`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const name = m.document?.file_name || (m.photo ? 'photo_' + m.message_id + '.jpg' : path.basename(f.file_path));
        const saved = await putInbox(this.u, name, Buffer.from(await r.arrayBuffer()));
        const copy = await storeCopy(this.u, saved);
        files.push({ ...saved, fid: copy?.fid });
      } catch (e) { return this.send('⚠️ Не смогла принять файл: ' + e.message); }
    }
    if (!txt && !files.length) return;
    let r;
    try { r = chat.submit({ text: txt, files, origin: 'tg' }); }
    catch (e) { return this.send('⚠️ ' + e.message); }
    /* Мочи занята: сообщение ждёт ближайшей паузы между шагами */
    if (r.queued) return this.send('📝 Передала Мочи — прочтёт после текущего шага. /now — прочитать сейчас, /stop — остановить.', { reply_to_message_id: m.message_id }).catch(() => {});
  }

  /* ход работы и итог — в Telegram */
  watch() {
    const chat = getChat(this.u);
    const onRun = r => {
      if (!r.running || !this.v.chatId || r.origin !== 'tg') return;
      this.status = null;
      this.send('⏳ Думаю…').then(m => { this.status = m.message_id; }).catch(() => {});
      api(this.v.token, 'sendChatAction', { chat_id: this.v.chatId, action: 'typing' }).catch(() => {});
    };
    const onTool = e => {
      if (!this.status || chat.doc.v.run?.origin !== 'tg') return;
      clearTimeout(this.editT);
      const go = () => { this.lastEdit = Date.now(); api(this.v.token, 'editMessageText', { chat_id: this.v.chatId, message_id: this.status, text: `⏳ ${e.label}… (шаг ${chat.doc.v.run?.steps || 1})` }).catch(() => {}); };
      const wait = 3000 - (Date.now() - this.lastEdit);
      if (wait <= 0) go(); else this.editT = setTimeout(go, wait);
    };
    const onFile = f => { const r = chat.doc.v.run; if (r?.tg || r?.origin === 'tg' || this.wants(chat)) this.doc(f.name, f.data, f.note); };
    /* ответ модели на сообщение из Telegram, пока задача ещё идёт (например, на вопрос по ходу дела) */
    const onAside = t => { if (this.v.chatId) this.say(t); };
    const onDone = async d => {
      if (!this.v.chatId) return;
      clearTimeout(this.editT);
      const tgRun = d.origin === 'tg' || d.tg;
      if (!tgRun && !this.wants(chat)) return;
      if (tgRun && this.status) await api(this.v.token, 'editMessageText', { chat_id: this.v.chatId, message_id: this.status, text: d.err ? '⚠️ Ошибка' : d.stopped ? '⏹ Остановлено' : `✅ Готово · шагов: ${d.steps} · ${dur(d.ms)}` }).catch(() => {});
      this.status = null;
      if (d.err) return this.say('⚠️ ' + (d.err.status ? 'Ошибка модели: HTTP ' + d.err.status : d.err.message));
      if (d.stopped) return tgRun ? undefined : this.say('⏹ Задача остановлена.');
      const text = d.text || 'Готово.';
      await this.say(tgRun ? text : '✅ Мочи закончила задачу (' + dur(d.ms) + '):\n\n' + text);
    };
    chat.on('run', onRun); chat.on('tool', onTool); chat.on('file', onFile); chat.on('done', onDone); chat.on('aside', onAside);
    this.unwatch = () => { chat.off('run', onRun); chat.off('tool', onTool); chat.off('file', onFile); chat.off('done', onDone); chat.off('aside', onAside); };
  }
  wants(chat) { const n = this.v.notify || 'away'; return n === 'always' || (n === 'away' && chat.away); }
}

/* ---------- управление ---------- */
export function tgState(u) {
  const v = conf(u).v;
  return v.token ? { connected: true, bot: v.bot, linked: !!v.chatId, tgUser: v.tgUser || null, notify: v.notify || 'away', error: v.error || null,
    link: v.link && v.linkExp > Date.now() ? `https://t.me/${v.bot}?start=${v.link}` : null, running: !!bots.get(u.id)?.ac } : { connected: false };
}

export function newLink(u) {
  const c = conf(u);
  if (!c.v.token) throw new Error('бот не подключён');
  c.v.link = rid(10); c.v.linkExp = Date.now() + LINK_TTL; c.save();
  return `https://t.me/${c.v.bot}?start=${c.v.link}`;
}

export async function connect(u, token) {
  token = String(token || '').trim();
  if (!TOKEN_RE.test(token)) throw new Error('это не похоже на токен бота (вид: 123456789:AAE…). Его выдаёт @BotFather');
  for (const other of usersFn()) if (other.id !== u.id && conf(other).v.token === token) throw new Error('этот бот уже подключён к другому пользователю');
  const me = await api(token, 'getMe').catch(e => { throw new Error('Telegram не принял токен: ' + e.message); });
  await api(token, 'deleteWebhook', {}).catch(() => {});
  await api(token, 'setMyCommands', { commands: [
    { command: 'status', description: 'Что Мочи сейчас делает' }, { command: 'stop', description: 'Остановить задачу' }, { command: 'now', description: 'Прочитать новые сообщения сейчас' },
    { command: 'new', description: 'Очистить чат' }, { command: 'web', description: 'Ссылка на веб-чат' }, { command: 'help', description: 'Помощь' }] }).catch(() => {});
  bots.get(u.id)?.stop();
  const c = conf(u), keep = c.v.token === token ? { chatId: c.v.chatId, tgUser: c.v.tgUser } : {};
  c.v = { token, bot: me.username, botName: me.first_name, notify: c.v.notify || 'away', ...keep };
  c.save();
  const b = new Bot(u); bots.set(u.id, b); b.start();
  return { bot: me.username, link: newLink(u), linked: !!keep.chatId };
}

export function disconnect(u) {
  bots.get(u.id)?.stop(); bots.delete(u.id);
  const c = conf(u); c.v = {}; c.save();
}

export function setNotify(u, mode) {
  if (!['away', 'always', 'off'].includes(mode)) throw new Error('режим: away, always или off');
  const c = conf(u); if (!c.v.token) throw new Error('бот не подключён');
  c.v.notify = mode; c.save();
}

export function stopUser(u) { bots.get(u.id)?.stop(); bots.delete(u.id); }

export function initTelegram(getUsers) {
  usersFn = getUsers;
  for (const u of getUsers()) if (conf(u).v.token && !conf(u).v.error) { const b = new Bot(u); bots.set(u.id, b); b.start(); }
  hooks.tg = {
    statusLine(u) {
      const s = tgState(u);
      if (!s.connected) return 'Telegram не подключён.';
      return `Telegram: бот @${s.bot} подключён, ${s.linked ? 'чат пользователя привязан (@' + s.tgUser + ')' : 'но пользователь ещё не привязал свой чат'}; уведомления: ${s.notify}.` + (s.error ? ' Проблема: ' + s.error + '.' : '');
    },
    async tool(chat, nm, a) {
      const u = chat.u;
      if (nm === 'telegram_connect') {
        const r = await connect(u, a.token);
        chat.scrub(String(a.token || '').trim());
        return r.linked
          ? `Бот @${r.bot} подключён, чат пользователя уже привязан — уведомления и управление работают.`
          : `Бот @${r.bot} подключён. Передай пользователю ссылку для привязки (действует 30 минут): ${r.link} — пусть откроет её и нажмёт «Старт».`;
      }
      if (nm === 'telegram_status') {
        const s = tgState(u);
        if (!s.connected) return 'Telegram не подключён. Нужен токен бота от @BotFather.';
        const link = a.new_link || (!s.linked && !s.link) ? newLink(u) : s.link;
        return hooks.tg.statusLine(u) + (link && (!s.linked || a.new_link) ? ' Ссылка для привязки (30 минут): ' + link : '');
      }
      if (nm === 'telegram_send') {
        const s = tgState(u);
        if (!s.linked) return 'Ошибка: Telegram не привязан. ' + (s.connected ? 'Пусть пользователь откроет ссылку из telegram_status.' : 'Сначала telegram_connect.');
        const b = bots.get(u.id);
        for (const p of chunks(plain(a.text))) await b.send(p);
        return 'Сообщение отправлено в Telegram.';
      }
      if (nm === 'telegram_notify_mode') { setNotify(u, a.mode); return 'Режим уведомлений: ' + a.mode; }
      if (nm === 'telegram_disconnect') { disconnect(u); return 'Telegram отключён.'; }
      return 'Ошибка: неизвестный инструмент ' + nm;
    },
  };
}

