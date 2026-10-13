/* Настройки сервера — только из переменных окружения (их пишет установщик в /etc/personalcomputer/personalcomputer.env) */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const dev = env.PERSONALCOMPUTER_DEV === '1';
const abs = p => path.resolve(p);
const web = abs(env.PERSONALCOMPUTER_WEB || path.join(here, '..', '..'));

export const CFG = {
  dev,
  host: env.PERSONALCOMPUTER_HOST || '127.0.0.1',
  port: +env.PERSONALCOMPUTER_PORT || 8787,
  /* приватные данные сервера: пароли, сессии, ключи API, токены ботов (0700, пользователь personalcomputer) */
  data: abs(env.PERSONALCOMPUTER_DATA || '/var/lib/personalcomputer/data'),
  /* рабочие папки агента (владелец personalcomputer-agent, группа personalcomputer) */
  work: abs(env.PERSONALCOMPUTER_WORK || '/var/lib/personalcomputer/agent'),
  /* корень сайта: index.html, sw.js, manifest, icons */
  web,
  /* обновления: build.json (репозиторий, ветка, коммит) кладёт установщик рядом с кодом;
     в updateDir root-служба personalcomputer-update пишет ход обновления (пусто — обновлять из браузера нельзя) */
  buildFile: abs(env.PERSONALCOMPUTER_BUILD || path.join(web, 'build.json')),
  updateDir: env.PERSONALCOMPUTER_UPDATE_DIR ? abs(env.PERSONALCOMPUTER_UPDATE_DIR) : '',
  updateApi: (env.PERSONALCOMPUTER_UPDATE_API || 'https://api.github.com').replace(/\/+$/, ''),
  updateWeb: (env.PERSONALCOMPUTER_UPDATE_WEB || 'https://github.com').replace(/\/+$/, ''),
  publicUrl: (env.PERSONALCOMPUTER_PUBLIC_URL || '').replace(/\/+$/, ''),
  /* исполнитель команд и терминал — отдельные службы от имени personalcomputer-agent */
  runnerSock: env.PERSONALCOMPUTER_RUNNER_SOCK || (dev ? 'inline' : '/run/personalcomputer-runner/runner.sock'),
  ttydSock: env.PERSONALCOMPUTER_TTYD_SOCK || '/run/personalcomputer-term/ttyd.sock',
  /* за Caddy на этой же машине: доверяем X-Forwarded-* только от 127.0.0.1 */
  trustProxy: env.PERSONALCOMPUTER_TRUST_PROXY ? env.PERSONALCOMPUTER_TRUST_PROXY === '1' : !dev,
  secureCookie: env.PERSONALCOMPUTER_SECURE_COOKIE ? env.PERSONALCOMPUTER_SECURE_COOKIE === '1' : !dev,
  /* полный доступ агента (root через sudo без пароля): его включает и выключает root-служба personalcomputer-access,
     она же правит PERSONALCOMPUTER_AGENT_SUDO в personalcomputer.env и перезапускает исполнитель. accessCtl — служба установлена */
  agentSudo: env.PERSONALCOMPUTER_AGENT_SUDO === '1',
  accessCtl: env.PERSONALCOMPUTER_ACCESS_CTL === '1',
  sudo: env.PERSONALCOMPUTER_SUDO || 'sudo',
  maxSteps: Math.max(5, +env.PERSONALCOMPUTER_MAX_STEPS || 100),
  maxFile: (+env.PERSONALCOMPUTER_MAX_FILE_MB || 50) * 2 ** 20,
  /* загрузка файла в проводник (вкладка «Файлы») */
  maxUpload: (+env.PERSONALCOMPUTER_MAX_UPLOAD_MB || 4096) * 2 ** 20,
  allowRegister: env.PERSONALCOMPUTER_OPEN_REGISTRATION === '1', /* по умолчанию — только по приглашению */
  searchMcp: env.PERSONALCOMPUTER_SEARCH_MCP ?? 'https://search.parallel.ai/mcp',
  /* ядро Xray для прокси vless/vmess/trojan/ss/hysteria2 (ставит установщик; пусто — ищем в /opt/personalcomputer/bin и PATH) */
  xray: env.PERSONALCOMPUTER_XRAY || '',
  /* «Проверить» в настройках прокси: откуда узнаём адрес и страну выхода (ответ вида ip=…, loc=…) */
  proxyTrace: env.PERSONALCOMPUTER_PROXY_TRACE || 'https://www.cloudflare.com/cdn-cgi/trace',
  tgApi: (env.PERSONALCOMPUTER_TG_API || 'https://api.telegram.org').replace(/\/+$/, ''),
};
