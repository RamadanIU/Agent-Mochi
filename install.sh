#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  Мочи — облачный агент. Установка на сервер одной командой:              │
# │                                                                          │
# │  curl -fsSL https://raw.githubusercontent.com/RamadanIU/Agent-Mochi/HEAD/install.sh | sudo bash
# │                                                                          │
# │  Свой домен:   … | sudo bash -s -- --domain mochi.example.com            │
# │  Без HTTPS (только через SSH-туннель):  … | sudo bash -s -- --no-tls     │
# │  Помощь:       … | sudo bash -s -- --help                                │
# └──────────────────────────────────────────────────────────────────────────┘
# Что делает: определяет ОС и архитектуру, ставит зависимости, Node.js, ttyd и Caddy
# (с проверкой контрольных сумм), заводит отдельных пользователей, службы systemd/OpenRC,
# HTTPS-сертификат и печатает ссылку для первой регистрации. Повторный запуск = обновление.
set -Eeuo pipefail
umask 022  # всё создаваемое — не доступно на запись чужим (окружение может прийти с umask 000)

REPO="${MOCHI_REPO:-RamadanIU/Agent-Mochi}"
REF="${MOCHI_REF:-HEAD}"  # HEAD = основная ветка репозитория, как бы она ни называлась
PREFIX=/opt/mochi
STATE=/var/lib/mochi
ETC=/etc/mochi
CADDY_HOME=/var/lib/mochi-caddy
PORT=8787
NODE_MAJOR=22
TTYD_VER=1.7.7
CADDY_VER=2.10.2

DOMAIN=""; EMAIL=""; TLS=auto; PUBLIC_URL=""; WITH_SUDO=0; MODE=install; PURGE=0; SRC=""; OPEN_FW=1

# ---------- оформление ----------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; P=$'\e[35m'; N=$'\e[0m'; else B=; G=; Y=; R=; P=; N=; fi
say()  { printf '%s\n' "${P}🐾${N} $*"; }
ok()   { printf '%s\n' "${G}✔${N} $*"; }
warn() { printf '%s\n' "${Y}!${N} $*" >&2; }
die()  { printf '%s\n' "${R}✘ $*${N}" >&2; exit 1; }
trap 'die "Ошибка в строке $LINENO (команда: $BASH_COMMAND). Установку можно спокойно запустить ещё раз."' ERR

usage() {
cat <<EOF
Установка Мочи.  Использование: install.sh [параметры]

  --domain NAME      свой домен (A-запись должна указывать на этот сервер); HTTPS — Let's Encrypt
  --email ADDR       почта для Let's Encrypt (необязательно)
  --no-tls           без Caddy/HTTPS: Мочи слушает только 127.0.0.1:${PORT}
                     (вход через SSH-туннель: ssh -L ${PORT}:127.0.0.1:${PORT} сервер → http://localhost:${PORT})
  --public-url URL   свой обратный прокси (nginx и т. п.) перед 127.0.0.1:${PORT}; вместе с --no-tls
  --port N           внутренний порт сервера (по умолчанию ${PORT})
  --with-sudo        дать агенту sudo без пароля (сможет ставить пакеты, но и получит полный root!)
  --no-firewall      не открывать порты 80/443 в ufw/firewalld
  --ref BRANCH       ветка/тег репозитория ${REPO} (по умолчанию ${REF})
  --source DIR       взять код из локальной папки вместо GitHub
  --update           обновить код и зависимости, настройки оставить
  --uninstall        удалить программу (данные пользователей останутся в ${STATE})
  --purge            вместе с --uninstall: удалить и все данные
По умолчанию без домена используется адрес вида 1-2-3-4.sslip.io с настоящим сертификатом.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; TLS=on; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --no-tls) TLS=off; shift ;;
    --public-url) PUBLIC_URL="${2%/}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --with-sudo) WITH_SUDO=1; shift ;;
    --no-firewall) OPEN_FW=0; shift ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --source) SRC="${2:-}"; shift 2 ;;
    --update) MODE=update; shift ;;
    --uninstall) MODE=uninstall; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный параметр: $1 (см. --help)" ;;
  esac
done

[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "Неверный порт: $PORT"
[ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "Неверный домен: $DOMAIN"
[ -z "$EMAIL" ] || [[ "$EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || die "Неверная почта: $EMAIL"
[ -z "$PUBLIC_URL" ] || [[ "$PUBLIC_URL" =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || die "Неверный --public-url: $PUBLIC_URL"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && [ -f "${BASH_SOURCE[0]:-}" ]; then exec sudo -E bash "${BASH_SOURCE[0]}" "$@"; fi
  die "Нужны права root: запусти через sudo (… | sudo bash)"
fi

# ---------- система ----------
OS_ID=unknown; OS_NAME="Linux"
if [ -r /etc/os-release ]; then . /etc/os-release; OS_ID="${ID:-unknown}"; OS_NAME="${PRETTY_NAME:-$OS_ID}"; fi
[ "$(uname -s)" = Linux ] || die "Нужен Linux (а это $(uname -s))"

PM=""
for p in apt-get dnf yum apk pacman zypper; do command -v "$p" >/dev/null 2>&1 && { PM="$p"; break; }; done
[ -n "$PM" ] || die "Не нашла менеджер пакетов (apt, dnf, yum, apk, pacman, zypper)"

if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then INIT=systemd
elif command -v openrc-run >/dev/null 2>&1 || [ -x /sbin/openrc-run ]; then INIT=openrc
else die "Нужен systemd или OpenRC (в контейнере без init установка служб невозможна)"; fi

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH=x64;    TTYD_ARCH=x86_64;  CADDY_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; TTYD_ARCH=aarch64; CADDY_ARCH=arm64 ;;
  armv7l|armv7*) NODE_ARCH=armv7l; TTYD_ARCH=armhf;  CADDY_ARCH=armv7 ;;
  *) die "Архитектура $(uname -m) пока не поддерживается" ;;
esac
MUSL=0; { [ "$OS_ID" = alpine ] || ldd --version 2>&1 | grep -qi musl; } && MUSL=1

# контрольные суммы закреплённых версий (не скачиваем их с того же сервера, что и файлы)
ttyd_sha() { case "$1" in
  x86_64)  echo 8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;;
  aarch64) echo b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;;
  armhf)   echo 8240c8438b68d3b10b0e1a4e7c914d70fca6a7606b516f40bf40adfa1044d801 ;; esac; }
caddy_sha() { case "$1" in
  amd64) echo 747df7ee74de188485157a383633a1a963fd9233b71fbb4a69ddcbcc589ce4e2cc82dacf5dbbe136cb51d17e14c59daeb5d9bc92487610b0f3b93680b2646546 ;;
  arm64) echo 6ce061a690312ab38367df3c5d5f89a2e4a263e7300d300d87356211bb81e79b15933e6d6203e03fbf26f15cc0311f264805f336147dbdd24938d84b57a4421c ;;
  armv7) echo 215af42cf952726d962c9753a12c04248781221b66df8b7110726fa7905d7a5c2e50056e0b47ab3c709d3dcfb48fde0f11e184a6950de0a2ddf941d3e503d07b ;; esac; }

TMP=$(mktemp -d /tmp/mochi-install.XXXXXX)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# проверка контрольной суммы (работает и с BusyBox): sum_ok sha256|sha512 ОЖИДАЕМАЯ ФАЙЛ
sum_ok() { [ -n "$2" ] && [ "$("${1}sum" "$3" | cut -d' ' -f1)" = "$2" ]; }
fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 20 -o "$2" "$1" || die "Не скачалось: $1 — проверь интернет на сервере (DNS, прокси, firewall)"; }

svc() { # svc start|stop|restart|enable|disable NAME…
  local a=$1; shift
  for s in "$@"; do
    if [ "$INIT" = systemd ]; then
      case "$a" in enable) systemctl enable -q "$s" ;; disable) systemctl disable -q "$s" 2>/dev/null || true ;; *) systemctl "$a" "$s" ;; esac
    else
      case "$a" in
        enable) rc-update add "$s" default >/dev/null ;;
        disable) rc-update del "$s" default >/dev/null 2>&1 || true ;;
        restart) rc-service "$s" restart || { rc-service "$s" zap >/dev/null 2>&1; rc-service "$s" start; } ;;
        *) rc-service "$s" "$a" ;;
      esac
    fi
  done
}
SERVICES="mochi-runner mochi-term mochi"

# ---------- удаление ----------
if [ "$MODE" = uninstall ]; then
  say "Удаляю Мочи…"
  for s in mochi mochi-term mochi-runner mochi-caddy; do svc stop "$s" >/dev/null 2>&1 || true; svc disable "$s"; done
  rm -f /etc/systemd/system/mochi*.service /etc/init.d/mochi /etc/init.d/mochi-term /etc/init.d/mochi-runner /etc/init.d/mochi-caddy
  [ "$INIT" = systemd ] && systemctl daemon-reload
  rm -rf "$PREFIX" /usr/local/bin/mochi /etc/sudoers.d/mochi-agent
  if [ "$PURGE" = 1 ]; then
    rm -rf "$STATE" "$CADDY_HOME" "$ETC" /var/log/mochi
    for u in mochi-agent mochi mochi-caddy; do userdel "$u" >/dev/null 2>&1 || deluser "$u" >/dev/null 2>&1 || true; done
    groupdel mochi >/dev/null 2>&1 || delgroup mochi >/dev/null 2>&1 || true
    ok "Мочи удалена полностью, вместе с данными."
  else
    ok "Мочи удалена. Данные остались в $STATE и $ETC (удалить: --uninstall --purge)."
  fi
  exit 0
fi

# при обновлении — прежние параметры
if [ "$MODE" = update ] && [ -r "$ETC/install.conf" ]; then
  # shellcheck disable=SC1091
  . "$ETC/install.conf"
fi

say "${B}Устанавливаю Мочи${N} · $OS_NAME · $(uname -m) · $INIT · пакеты: $PM"

# ---------- пакеты ----------
pkgs() {
  case "$PM" in
    apt-get) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null; apt-get install -y -qq --no-install-recommends "$@" >/dev/null ;;
    dnf) dnf install -y -q "$@" >/dev/null ;;
    yum) yum install -y -q "$@" >/dev/null ;;
    apk) apk add --no-cache -q "$@" >/dev/null ;;
    pacman) pacman -Sy --noconfirm --needed "$@" >/dev/null ;;
    zypper) zypper -n -q install --no-recommends "$@" >/dev/null ;;
  esac
}
case "$PM" in
  apt-get) BASE="curl ca-certificates tar xz-utils gzip bash tmux git procps iproute2 passwd"; EXTRA="python3 python3-venv python3-pip build-essential unzip jq file less" ;;
  dnf|yum) BASE="curl ca-certificates tar xz gzip bash tmux git procps-ng iproute shadow-utils"; EXTRA="python3 python3-pip gcc make unzip jq file less" ;;
  apk)     BASE="curl ca-certificates tar xz gzip bash tmux git procps iproute2 shadow libstdc++ nodejs npm"; EXTRA="python3 py3-pip build-base unzip jq file less" ;;
  pacman)  BASE="curl ca-certificates tar xz gzip bash tmux git procps-ng iproute2"; EXTRA="python python-pip base-devel unzip jq file less" ;;
  zypper)  BASE="curl ca-certificates tar xz gzip bash tmux git procps iproute2 shadow"; EXTRA="python3 python3-pip gcc make unzip jq file less" ;;
esac
[ "$WITH_SUDO" = 1 ] && BASE="$BASE sudo"
say "Ставлю системные пакеты…"
# shellcheck disable=SC2086
pkgs $BASE || die "Не удалось поставить пакеты: $BASE"
# необязательное — инструменты для агента; без них всё равно работает
# shellcheck disable=SC2086
pkgs $EXTRA 2>/dev/null || warn "Часть дополнительных пакетов не поставилась ($EXTRA) — не страшно"
ok "Пакеты на месте"

mkdir -p "$PREFIX/bin"

# ---------- Node.js ----------
NODE="$PREFIX/node/bin/node"
if [ "$MUSL" = 1 ]; then
  NODE=$(command -v node || true)
  [ -n "$NODE" ] || die "Node.js не установился из пакетов"
else
  want=$(curl -fsSL --retry 3 "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" -o "$TMP/node.sha" && grep -oE "node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz" "$TMP/node.sha" | head -1) || die "Не скачался список версий Node.js"
  ver=${want#node-}; ver=${ver%%-linux*}
  if [ -x "$NODE" ] && [ "$("$NODE" -v)" = "$ver" ]; then ok "Node.js $ver уже стоит"
  else
    say "Скачиваю Node.js $ver…"
    fetch "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$want" "$TMP/$want"
    sum_ok sha256 "$(grep " $want\$" "$TMP/node.sha" | cut -d' ' -f1)" "$TMP/$want" || die "Контрольная сумма Node.js не совпала!"
    rm -rf "$PREFIX/node.new"; mkdir -p "$PREFIX/node.new"
    tar -xJf "$TMP/$want" -C "$PREFIX/node.new" --strip-components=1
    rm -rf "$PREFIX/node.old"; [ -d "$PREFIX/node" ] && mv "$PREFIX/node" "$PREFIX/node.old"
    mv "$PREFIX/node.new" "$PREFIX/node"; rm -rf "$PREFIX/node.old"
    ok "Node.js $ver"
  fi
fi
nmaj=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$nmaj" -ge 20 ] || die "Нужен Node.js 20+, а здесь $("$NODE" -v). Обнови систему (для Alpine — 3.20+)"

# ---------- ttyd ----------
if [ -x "$PREFIX/bin/ttyd" ] && "$PREFIX/bin/ttyd" --version 2>/dev/null | grep -q "$TTYD_VER"; then ok "ttyd $TTYD_VER уже стоит"
else
  say "Скачиваю ttyd $TTYD_VER…"
  fetch "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.${TTYD_ARCH}" "$TMP/ttyd"
  sum_ok sha256 "$(ttyd_sha "$TTYD_ARCH")" "$TMP/ttyd" || die "Контрольная сумма ttyd не совпала!"
  install -m 0755 "$TMP/ttyd" "$PREFIX/bin/ttyd"
  ok "ttyd $TTYD_VER"
fi

# ---------- адрес и HTTPS ----------
public_ip() {
  local ip=""
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]') || true
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$ip"; return; }
  done
}
if [ "$TLS" = auto ]; then
  IP=$(public_ip || true)
  if [ -n "$IP" ]; then DOMAIN="${IP//./-}.sslip.io"; TLS=on
  else warn "Не смогла узнать внешний IP — ставлю без HTTPS (вход через SSH-туннель). Свой домен: --domain"; TLS=off; fi
fi
if [ "$TLS" = on ]; then
  PUBLIC_URL="https://$DOMAIN"
  if command -v ss >/dev/null 2>&1; then
    busy=$(ss -Hltnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' || true)
    ours=0
    if [ "$INIT" = systemd ]; then systemctl is-active -q mochi-caddy 2>/dev/null && ours=1; else rc-service mochi-caddy status >/dev/null 2>&1 && ours=1; fi
    if [ -n "$busy" ] && [ "$ours" = 0 ]; then
      warn "Порты 80/443 уже заняты:"; printf '%s\n' "$busy" >&2
      die "Освободи их или поставь с --no-tls --public-url https://твой-домен и проксируй на 127.0.0.1:$PORT (с поддержкой WebSocket)"
    fi
  fi
  if [ -x "$PREFIX/bin/caddy" ] && "$PREFIX/bin/caddy" version 2>/dev/null | grep -q "v$CADDY_VER"; then ok "Caddy $CADDY_VER уже стоит"
  else
    say "Скачиваю Caddy $CADDY_VER (HTTPS)…"
    f="caddy_${CADDY_VER}_linux_${CADDY_ARCH}.tar.gz"
    fetch "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/$f" "$TMP/$f"
    sum_ok sha512 "$(caddy_sha "$CADDY_ARCH")" "$TMP/$f" || die "Контрольная сумма Caddy не совпала!"
    tar -xzf "$TMP/$f" -C "$TMP" caddy
    install -m 0755 "$TMP/caddy" "$PREFIX/bin/caddy"
    ok "Caddy $CADDY_VER"
  fi
fi
SECURE=0; [[ "$PUBLIC_URL" == https://* ]] && SECURE=1
TRUST=0; [ "$TLS" = on ] || [ -n "$PUBLIC_URL" ] && TRUST=1

# ---------- код Мочи ----------
say "Ставлю код Мочи…"
here=""; [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -z "$SRC" ] && [ -n "$here" ] && [ -f "$here/server/mochi.js" ] && [ -f "$here/index.html" ]; then SRC="$here"; fi
if [ -z "$SRC" ]; then
  fetch "https://codeload.github.com/${REPO}/tar.gz/${REF}" "$TMP/src.tgz" || die "Не скачался код ${REPO}@${REF}"
  mkdir -p "$TMP/src"; tar -xzf "$TMP/src.tgz" -C "$TMP/src" --strip-components=1
  SRC="$TMP/src"
fi
[ -f "$SRC/server/mochi.js" ] && [ -f "$SRC/index.html" ] || die "В $SRC нет server/mochi.js — это точно код Мочи?"
rm -rf "$PREFIX/app.new"; mkdir -p "$PREFIX/app.new"
cp -r "$SRC/index.html" "$SRC/sw.js" "$SRC/manifest.webmanifest" "$SRC/icons" "$SRC/server" "$PREFIX/app.new/"
rm -rf "$PREFIX/app.new/server/test" "$PREFIX/app.new/server/.dev"
chmod -R u=rwX,go=rX "$PREFIX/app.new"; chmod 0755 "$PREFIX/app.new/server/bin/"*
"$NODE" --check "$PREFIX/app.new/server/mochi.js" || die "Код не прошёл проверку синтаксиса"
rm -rf "$PREFIX/app.old"; [ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$PREFIX/app.new" "$PREFIX/app"
ok "Код: $(cd "$PREFIX/app/server" && "$NODE" -p 'require("./package.json").version')"

# ---------- пользователи ----------
NOLOGIN=$(command -v nologin || echo /bin/false)
getent group mochi >/dev/null || groupadd --system mochi
id mochi >/dev/null 2>&1 || useradd --system --gid mochi --home-dir "$STATE" --no-create-home --shell "$NOLOGIN" --comment "Mochi server" mochi
id mochi-agent >/dev/null 2>&1 || useradd --system --gid mochi --home-dir "$STATE/agent" --no-create-home --shell /bin/bash --comment "Mochi agent" mochi-agent
if [ "$TLS" = on ]; then
  getent group mochi-caddy >/dev/null || groupadd --system mochi-caddy
  id mochi-caddy >/dev/null 2>&1 || useradd --system --gid mochi-caddy --home-dir "$CADDY_HOME" --no-create-home --shell "$NOLOGIN" --comment "Mochi HTTPS" mochi-caddy
fi
# агент может разблокироваться и после «usermod -L»: пароль у системных пользователей не задан
passwd -l mochi-agent >/dev/null 2>&1 || true

# папки: права выставляем и при повторной установке
mkd() { mkdir -p "$3"; chown "$2" "$3"; chmod "$1" "$3"; }
mkd 0750 root:mochi "$STATE"
mkd 0700 mochi:mochi "$STATE/data"
mkd 2770 mochi-agent:mochi "$STATE/agent"
mkd 0755 root:root "$ETC"  # секретов здесь нет; Caddyfile читает mochi-caddy
mkd 0755 root:root /var/log/mochi
A="$STATE/agent"
mkd 0750 mochi-agent:mochi "$A/.local"
mkd 0750 mochi-agent:mochi "$A/.local/bin"
# оформление tmux — в $APP/bin/tmux.conf (цвета следуют теме); розовый ~/.tmux.conf
# от прежних версий установщика убираем, только если его не меняли
OLD_TMUX='# Мочи: терминал в браузере
set -g mouse on
set -g history-limit 50000
set -g default-terminal "xterm-256color"
set -g status-style "bg=#33254f,fg=#f3d9ff"
set -g status-left "[мочи] "
set -g status-right "%H:%M"
set -g window-status-current-style "bg=#ff6b9d,fg=#1b1230"'
if [ -f "$A/.tmux.conf" ] && [ "$(cat "$A/.tmux.conf")" = "$OLD_TMUX" ]; then rm -f "$A/.tmux.conf"; fi
[ -f "$A/.profile" ] || { cat > "$A/.profile" <<EOF
export PATH="\$HOME/.local/bin:$(dirname "$NODE"):\$PATH"
export NPM_CONFIG_PREFIX="\$HOME/.local"
[ -n "\$BASH_VERSION" ] && [ -f "\$HOME/.bashrc" ] && . "\$HOME/.bashrc"
EOF
chown mochi-agent:mochi "$A/.profile"; }
chmod 0640 "$A/.profile" 2>/dev/null || true
[ -f "$A/.bashrc" ] || { printf '%s\n' 'PS1="\[\e[35m\]мочи\[\e[0m\]:\[\e[32m\]\w\[\e[0m\]\$ "' 'alias ll="ls -la"' > "$A/.bashrc"; chown mochi-agent:mochi "$A/.bashrc"; }
chmod 0640 "$A/.bashrc" 2>/dev/null || true
[ -f "$A/README.txt" ] || { printf '%s\n' "Это рабочая папка агента Мочи." "Папки пользователей: <имя>/inbox (файлы от пользователя), <имя>/outbox (результаты)." > "$A/README.txt"; chown mochi-agent:mochi "$A/README.txt"; }
chmod 0640 "$A/README.txt" 2>/dev/null || true

if [ "$WITH_SUDO" = 1 ]; then
  echo "mochi-agent ALL=(ALL) NOPASSWD: ALL" > "$TMP/sudo"
  visudo -cf "$TMP/sudo" >/dev/null && install -m 0440 "$TMP/sudo" /etc/sudoers.d/mochi-agent
  warn "У агента есть sudo без пароля: он может всё, включая чтение данных сервера."
else
  rm -f /etc/sudoers.d/mochi-agent
fi

# ---------- настройки ----------
cat > "$ETC/mochi.env" <<EOF
# Настройки Мочи (после правки: sudo mochi restart). Секретов здесь нет.
MOCHI_HOST=127.0.0.1
MOCHI_PORT=$PORT
MOCHI_DATA=$STATE/data
MOCHI_WORK=$STATE/agent
MOCHI_WEB=$PREFIX/app
MOCHI_PUBLIC_URL=$PUBLIC_URL
MOCHI_SECURE_COOKIE=$SECURE
MOCHI_TRUST_PROXY=$TRUST
MOCHI_AGENT_SUDO=$WITH_SUDO
MOCHI_RUNNER_SOCK=/run/mochi-runner/runner.sock
MOCHI_TTYD_SOCK=/run/mochi-term/ttyd.sock
MOCHI_TTYD_BIN=$PREFIX/bin/ttyd
EOF
chmod 0640 "$ETC/mochi.env"; chown root:mochi "$ETC/mochi.env"
cat > "$ETC/install.conf" <<EOF
DOMAIN='$DOMAIN'
EMAIL='$EMAIL'
TLS='$TLS'
PUBLIC_URL='$PUBLIC_URL'
PORT='$PORT'
WITH_SUDO='$WITH_SUDO'
REPO='$REPO'
REF='$REF'
OPEN_FW='$OPEN_FW'
EOF
chmod 0600 "$ETC/install.conf"

if [ "$TLS" = on ]; then
  mkd 0700 mochi-caddy:mochi-caddy "$CADDY_HOME"
  {
    echo "{"
    echo "	admin off"
    [ -n "$EMAIL" ] && echo "	email $EMAIL"
    echo "}"
    echo "$DOMAIN {"
    echo "	reverse_proxy 127.0.0.1:$PORT {"
    echo "		flush_interval -1"
    echo "	}"
    echo "	header {"
    echo "		Strict-Transport-Security \"max-age=31536000\""
    echo "		-Server"
    echo "	}"
    echo "}"
  } > "$ETC/Caddyfile"
  chmod 0644 "$ETC/Caddyfile"
  if ! HOME="$TMP" XDG_DATA_HOME="$TMP" XDG_CONFIG_HOME="$TMP" "$PREFIX/bin/caddy" validate --config "$ETC/Caddyfile" --adapter caddyfile >"$TMP/caddy.log" 2>&1; then
    tail -n 5 "$TMP/caddy.log" >&2; die "Caddyfile не прошёл проверку"
  fi
  SERVICES="$SERVICES mochi-caddy"
fi

# ---------- службы ----------
APP="$PREFIX/app/server"
if [ "$INIT" = systemd ]; then
  HARD_SERVER="NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$STATE/data $STATE/agent
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK"
  # агент — обычный пользователь без доступа к данным сервера и домашним папкам людей
  if [ "$WITH_SUDO" = 1 ]; then HARD_AGENT="InaccessiblePaths=-$STATE/data"
  else HARD_AGENT="NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
InaccessiblePaths=-$STATE/data
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes"; fi

  cat > /etc/systemd/system/mochi-runner.service <<EOF
[Unit]
Description=Мочи — исполнитель команд агента
After=network-online.target
Wants=network-online.target

[Service]
User=mochi-agent
Group=mochi
EnvironmentFile=$ETC/mochi.env
Environment=HOME=$STATE/agent
WorkingDirectory=$STATE/agent
ExecStart=$NODE $APP/mochi.js runner
RuntimeDirectory=mochi-runner
RuntimeDirectoryMode=0750
UMask=0007
Restart=always
RestartSec=2
KillMode=control-group
$HARD_AGENT

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/mochi-term.service <<EOF
[Unit]
Description=Мочи — терминал (ttyd на unix-сокете)
After=network-online.target

[Service]
User=mochi-agent
Group=mochi
EnvironmentFile=$ETC/mochi.env
Environment=HOME=$STATE/agent SHELL=/bin/bash
WorkingDirectory=$STATE/agent
ExecStart=$APP/bin/mochi-ttyd
RuntimeDirectory=mochi-term
RuntimeDirectoryMode=0750
UMask=0007
Restart=always
RestartSec=2
$HARD_AGENT

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/mochi.service <<EOF
[Unit]
Description=Мочи — облачный агент (веб, API, Telegram)
After=network-online.target mochi-runner.service mochi-term.service
Wants=network-online.target mochi-runner.service mochi-term.service

[Service]
User=mochi
Group=mochi
EnvironmentFile=$ETC/mochi.env
WorkingDirectory=$STATE/data
ExecStart=$NODE $APP/mochi.js serve
UMask=0007
Restart=always
RestartSec=2
TimeoutStopSec=15
$HARD_SERVER

[Install]
WantedBy=multi-user.target
EOF
  if [ "$TLS" = on ]; then
    cat > /etc/systemd/system/mochi-caddy.service <<EOF
[Unit]
Description=Мочи — HTTPS (Caddy)
After=network-online.target mochi.service
Wants=network-online.target

[Service]
User=mochi-caddy
Group=mochi-caddy
Environment=HOME=$CADDY_HOME XDG_DATA_HOME=$CADDY_HOME XDG_CONFIG_HOME=$CADDY_HOME
ExecStart=$PREFIX/bin/caddy run --config $ETC/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
TimeoutStopSec=10
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$CADDY_HOME
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
  else
    systemctl disable --now mochi-caddy >/dev/null 2>&1 || true; rm -f /etc/systemd/system/mochi-caddy.service
  fi
  systemctl daemon-reload
else
  # OpenRC (Alpine и др.)
  orc() { # имя пользователь:группа описание папка-в-/run рабочая-папка "ПЕРЕМЕННЫЕ" "команда" ["after …"]
    local n=$1 ug=$2 d=$3 rt=$4 wd=$5 envs=$6 cmd=$7 deps=${8:-}
    cat > "/etc/init.d/$n" <<EOF
#!/sbin/openrc-run
description="$d"
supervisor=supervise-daemon
command="/bin/sh"
command_args="-c 'umask 007; set -a; . $ETC/mochi.env; $envs; set +a; exec $cmd'"
command_user="$ug"
directory="$wd"
output_log="/var/log/mochi/$n.log"
error_log="/var/log/mochi/$n.log"
respawn_delay=2
respawn_max=0
depend() {
	use net dns
	after net firewall
	${deps:-:}
}
start_pre() {
	${rt:+checkpath -d -m 0750 -o $ug /run/$rt}
	checkpath -f -m 0640 -o $ug /var/log/mochi/$n.log
}
EOF
    chmod 0755 "/etc/init.d/$n"
  }
  orc mochi-runner mochi-agent:mochi "Мочи — исполнитель команд" mochi-runner "$STATE/agent" "HOME=$STATE/agent" "$NODE $APP/mochi.js runner"
  orc mochi-term mochi-agent:mochi "Мочи — терминал" mochi-term "$STATE/agent" "HOME=$STATE/agent SHELL=/bin/bash" "$APP/bin/mochi-ttyd"
  orc mochi mochi:mochi "Мочи — облачный агент" "" "$STATE/data" "HOME=$STATE" "$NODE $APP/mochi.js serve" "after mochi-runner mochi-term"
  if [ "$TLS" = on ]; then
    command -v setcap >/dev/null 2>&1 || pkgs libcap-setcap >/dev/null 2>&1 || pkgs libcap >/dev/null 2>&1 || true
    setcap cap_net_bind_service=+ep "$PREFIX/bin/caddy" || die "Не удалось разрешить Caddy порты 80/443 (нужен setcap)"
    orc mochi-caddy mochi-caddy:mochi-caddy "Мочи — HTTPS" "" "$CADDY_HOME" "HOME=$CADDY_HOME XDG_DATA_HOME=$CADDY_HOME XDG_CONFIG_HOME=$CADDY_HOME" "$PREFIX/bin/caddy run --config $ETC/Caddyfile --adapter caddyfile" "after mochi"
  fi
fi

# ---------- команда mochi ----------
cat > /usr/local/bin/mochi <<EOF
#!/bin/sh
# Управление Мочи. Подробнее: mochi help
INIT=$INIT
NODE=$NODE
APP=$APP
SERVICES="$SERVICES"
REPO="$REPO"
REF="$REF"
EOF
cat >> /usr/local/bin/mochi <<'EOF'
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Нужно через sudo: sudo mochi $*" >&2; exit 1; }; }
each() { for s in $SERVICES; do if [ "$INIT" = systemd ]; then systemctl "$1" "$s"; else rc-service "$s" "$1"; fi; done; }
case "${1:-help}" in
  start|stop|restart) need_root "$@"; each "$1" ;;
  logs)
    if [ "$INIT" = systemd ]; then shift; exec journalctl -u 'mochi*' -n 200 "${@:--f}"; else exec tail -n 200 -f /var/log/mochi/*.log; fi ;;
  update) need_root "$@"; curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/install.sh" | bash -s -- --update ;;
  uninstall) need_root "$@"; shift; curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/install.sh" | bash -s -- --uninstall "$@" ;;
  status)
    for s in $SERVICES; do
      if [ "$INIT" = systemd ]; then printf '%-14s %s\n' "$s" "$(systemctl is-active "$s")"; else printf '%-14s ' "$s"; rc-service "$s" status 2>/dev/null | tail -1; fi
    done
    [ "$(id -u)" -eq 0 ] && { set -a; . /etc/mochi/mochi.env; set +a; "$NODE" "$APP/mochi.js" status; } ;;
  invite|users|passwd|admin|deluser)
    need_root "$@"; set -a; . /etc/mochi/mochi.env; set +a; exec "$NODE" "$APP/mochi.js" "$@" ;;
  *)
    cat <<'H'
mochi invite [дней]     — ссылка-приглашение для регистрации
mochi users             — пользователи
mochi passwd <имя>      — сбросить пароль (новый будет напечатан)
mochi admin <имя> [off] — сделать (снять) администратора
mochi deluser <имя>     — удалить пользователя
mochi status | logs     — состояние и журнал
mochi start | stop | restart
mochi update            — обновить Мочи (данные сохраняются)
mochi uninstall [--purge]
H
    ;;
esac
EOF
chmod 0755 /usr/local/bin/mochi

# ---------- брандмауэр ----------
if [ "$TLS" = on ] && [ "$OPEN_FW" = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ok "ufw: открыты 80 и 443"
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd -q --permanent --add-service=http --add-service=https && firewall-cmd -q --reload && ok "firewalld: открыты http и https"
  fi
fi

# ---------- запуск ----------
say "Запускаю службы…"
for s in $SERVICES; do svc enable "$s"; done
for s in $SERVICES; do svc restart "$s" >/dev/null 2>&1 || svc start "$s" >/dev/null; done

up=0
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { up=1; break; }; sleep 0.5; done
if [ "$up" != 1 ]; then
  [ "$INIT" = systemd ] && journalctl -u mochi -n 30 --no-pager >&2 || tail -n 30 /var/log/mochi/mochi.log >&2 || true
  die "Сервер Мочи не запустился (журнал выше; подробнее: mochi logs)"
fi
ok "Сервер Мочи работает"

set -a; . "$ETC/mochi.env"; set +a
nusers=$("$NODE" "$APP/mochi.js" status 2>/dev/null | grep -oE '"users": *[0-9]+' | grep -oE '[0-9]+$' || echo 0)

URL="${PUBLIC_URL:-http://localhost:$PORT}"
if [ "$TLS" = on ]; then
  say "Получаю HTTPS-сертификат для $DOMAIN (до 1,5 минуты)…"
  tls=0
  for _ in $(seq 1 45); do curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1 && { tls=1; break; }; sleep 2; done
  if [ "$tls" = 1 ]; then ok "HTTPS готов"
  else warn "HTTPS пока не отвечает. Проверь: порты 80 и 443 открыты у хостера (облачный firewall), домен $DOMAIN указывает на этот сервер. Журнал: mochi logs"; fi
fi

echo
printf '%s\n' "${B}${P}  ╭─────────────────────────────────────────────╮${N}"
printf '%s\n' "${B}${P}  │   Мочи установлена!  (=^･ω･^=)               │${N}"
printf '%s\n' "${B}${P}  ╰─────────────────────────────────────────────╯${N}"
if [ "${nusers:-0}" = 0 ]; then
  inv=$("$NODE" "$APP/mochi.js" invite 7 | grep -oE '[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}' | head -1)
  echo
  echo "  Открой и зарегистрируйся (первый пользователь станет администратором):"
  echo
  echo "    ${B}${URL}/?invite=${inv}${N}"
  echo
  echo "  Код приглашения: ${B}${inv}${N}  (одноразовый, 7 дней; новый: sudo mochi invite)"
else
  echo; echo "  Адрес: ${B}${URL}/${N}   (пользователей: $nusers)"
fi
if [ "$TLS" = off ] && [ -z "$PUBLIC_URL" ]; then
  echo
  echo "  Мочи слушает только 127.0.0.1. С компьютера: ssh -L $PORT:127.0.0.1:$PORT $(id -un 2>/dev/null)@<сервер>"
  echo "  и открой http://localhost:$PORT"
fi
echo
echo "  Дальше: в настройках Мочи → «Модель» — вставь ключ API. Telegram: попроси Мочи «подключи Telegram»."
echo "  Управление: ${B}mochi help${N}"
echo
