/* Настройки сервера — только из переменных окружения (их пишет установщик в /etc/mochi/mochi.env) */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const dev = env.MOCHI_DEV === '1';
const abs = p => path.resolve(p);

export const CFG = {
  dev,
  host: env.MOCHI_HOST || '127.0.0.1',
  port: +env.MOCHI_PORT || 8787,
  /* приватные данные сервера: пароли, сессии, ключи API, токены ботов (0700, пользователь mochi) */
  data: abs(env.MOCHI_DATA || '/var/lib/mochi/data'),
  /* рабочие папки агента (владелец mochi-agent, группа mochi) */
  work: abs(env.MOCHI_WORK || '/var/lib/mochi/agent'),
  /* корень сайта: index.html, sw.js, manifest, icons */
  web: abs(env.MOCHI_WEB || path.join(here, '..', '..')),
  publicUrl: (env.MOCHI_PUBLIC_URL || '').replace(/\/+$/, ''),
  /* исполнитель команд и терминал — отдельные службы от имени mochi-agent */
  runnerSock: env.MOCHI_RUNNER_SOCK || (dev ? 'inline' : '/run/mochi-runner/runner.sock'),
  ttydSock: env.MOCHI_TTYD_SOCK || '/run/mochi-term/ttyd.sock',
  /* за Caddy на этой же машине: доверяем X-Forwarded-* только от 127.0.0.1 */
  trustProxy: env.MOCHI_TRUST_PROXY ? env.MOCHI_TRUST_PROXY === '1' : !dev,
  secureCookie: env.MOCHI_SECURE_COOKIE ? env.MOCHI_SECURE_COOKIE === '1' : !dev,
  agentSudo: env.MOCHI_AGENT_SUDO === '1',
  maxSteps: Math.max(5, +env.MOCHI_MAX_STEPS || 100),
  maxFile: (+env.MOCHI_MAX_FILE_MB || 50) * 2 ** 20,
  allowRegister: env.MOCHI_OPEN_REGISTRATION === '1', /* по умолчанию — только по приглашению */
  searchMcp: env.MOCHI_SEARCH_MCP ?? 'https://search.parallel.ai/mcp',
  tgApi: (env.MOCHI_TG_API || 'https://api.telegram.org').replace(/\/+$/, ''),
};
