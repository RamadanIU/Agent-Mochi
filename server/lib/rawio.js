/* Потоки «заголовок + байты» между сервером, исполнителем и root-помощником (sudo node mochi.js fsget/fsput):
   первая строка — JSON, дальше — сырые байты файла. */
import { Readable } from 'node:stream';

/* прочитать первую строку-JSON; остаток возвращается в поток (unshift), поток — на паузе */
export function readHead(s, max = 2 ** 20) {
  return new Promise((ok, no) => {
    const parts = [];
    let len = 0, fin = false;
    const done = (e, v) => {
      if (fin) return; fin = true;
      s.off('data', onData); s.off('end', onEnd); s.off('close', onEnd); s.off('error', onErr);
      if (e) no(e); else ok(v);
    };
    const onData = d => {
      const i = d.indexOf(10);
      if (i < 0) { parts.push(d); len += d.length; if (len > max) { s.destroy(); done(new Error('слишком длинный заголовок')); } return; }
      parts.push(d.subarray(0, i));
      s.pause();
      let head;
      try { head = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { s.destroy(); return done(new Error('испорченный заголовок')); }
      const rest = d.subarray(i + 1);
      if (rest.length) s.unshift(rest);
      done(null, { head, stream: s });
    };
    const onEnd = () => done(new Error('поток закрылся раньше заголовка'));
    const onErr = e => done(e);
    s.on('data', onData); s.on('end', onEnd); s.on('close', onEnd); s.on('error', onErr);
  });
}

/* ровно n байт из сокета (first — то, что уже пришло вместе с заголовком); сокет потом остаётся для ответа */
export function bodyOf(sock, first, n) {
  let got = 0, fin = false;
  const out = new Readable({ read() { sock.resume(); } });
  out.on('error', () => {}); /* обрыв увидит тот, кто читает (pipeline), — а пока он не начал, процесс не должен падать */
  const stop = () => { fin = true; sock.off('data', push); sock.off('end', cut); sock.off('close', cut); };
  const push = c => {
    if (fin) return;
    if (got + c.length > n) c = c.subarray(0, n - got);
    got += c.length;
    if (c.length && !out.push(c)) sock.pause();
    if (got >= n) { stop(); out.push(null); }
  };
  const cut = () => { if (fin) return; stop(); out.destroy(new Error('загрузка оборвалась')); };
  if (n <= 0) { fin = true; out.push(null); return out; }
  sock.on('data', push); sock.on('end', cut); sock.on('close', cut);
  if (first && first.length) push(first);
  return out;
}

/* разбор JSON-строк из сокета (Buffer, без порчи многобайтных символов на стыке кусков).
   onLine(msg, rest) может вернуть true — «дальше сырые байты»: разбор прекращается, rest — то, что пришло после строки */
export function lines(sock, onLine, max = 32 * 2 ** 20) {
  let parts = [], len = 0;
  const onData = d => {
    let i = d.indexOf(10);
    while (i >= 0) {
      const raw = parts.length ? Buffer.concat([...parts, d.subarray(0, i)]) : d.subarray(0, i);
      parts = []; len = 0;
      d = d.subarray(i + 1);
      let m = null;
      try { m = JSON.parse(raw.toString('utf8')); } catch {}
      if (m && onLine(m, d) === true) { sock.off('data', onData); return; }
      i = d.indexOf(10);
    }
    if (d.length) { parts.push(d); len += d.length; if (len > max) sock.destroy(); }
  };
  sock.on('data', onData);
}
