#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  Personal Computer — облачный агент. Установка одной командой:           │
# │                                                                          │
# │  curl -fsSL https://raw.githubusercontent.com/RamadanIU/Agent-Mochi/HEAD/install.sh | sudo bash
# │                                                                          │
# │  Свой домен:   … | sudo bash -s -- --domain personalcomputer.example.com            │
# │  Без HTTPS (только через SSH-туннель):  … | sudo bash -s -- --no-tls     │
# │  Помощь:       … | sudo bash -s -- --help                                │
# └──────────────────────────────────────────────────────────────────────────┘
# Что делает: определяет ОС и архитектуру, ставит зависимости, Node.js, ttyd, Caddy и Xray (прокси)
# (с проверкой контрольных сумм), заводит отдельных пользователей, службы systemd/OpenRC,
# HTTPS-сертификат и печатает ссылку для первой регистрации. Повторный запуск = обновление.
set -Eeuo pipefail
umask 022  # всё создаваемое — не доступно на запись чужим (окружение может прийти с umask 000)

REPO="${PERSONALCOMPUTER_REPO:-RamadanIU/Agent-Mochi}"
REF="${PERSONALCOMPUTER_REF:-HEAD}"  # HEAD = основная ветка репозитория, как бы она ни называлась
# скачать ровно этот коммит (так делает personalcomputer-update; обновление версий до переименования передаёт MOCHI_COMMIT);
# ветка в настройках не меняется
COMMIT="${PERSONALCOMPUTER_COMMIT:-${MOCHI_COMMIT:-}}"
# установщик запущен службой обновления (её не перезапускаем — это оборвало бы обновление)
UPDATER="${PERSONALCOMPUTER_UPDATER:-${MOCHI_UPDATER:-}}"
PREFIX=/opt/personalcomputer
STATE=/var/lib/personalcomputer
ETC=/etc/personalcomputer
CADDY_HOME=/var/lib/personalcomputer-caddy
# до переименования проект назывался mochi: пользователи mochi, mochi-agent, mochi-caddy, папки /opt/mochi,
# /var/lib/mochi, /etc/mochi, службы mochi*, команда mochi. Их переносит раздел «переезд» ниже
OLD=mochi
OLD_PREFIX=/opt/$OLD
OLD_STATE=/var/lib/$OLD
OLD_ETC=/etc/$OLD
OLD_CADDY_HOME=/var/lib/$OLD-caddy
PORT=8787
NODE_MAJOR=22
TTYD_VER=1.7.7
CADDY_VER=2.10.2
XRAY_VER=26.9.9

DOMAIN=""; EMAIL=""; TLS=auto; PUBLIC_URL=""; WITH_SUDO=0; SUDO_ARG=""; MODE=install; PURGE=0; SRC=""; OPEN_FW=1

# ---------- оформление ----------
if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; P=$'\e[35m'; N=$'\e[0m'; else B=; G=; Y=; R=; P=; N=; fi
say()  { printf '%s\n' "${P}🐾${N} $*"; }
ok()   { printf '%s\n' "${G}✔${N} $*"; }
warn() { printf '%s\n' "${Y}!${N} $*" >&2; }
die()  { printf '%s\n' "${R}✘ $*${N}" >&2; exit 1; }
trap 'die "Ошибка в строке $LINENO (команда: $BASH_COMMAND). Установку можно спокойно запустить ещё раз."' ERR

usage() {
cat <<EOF
Установка Personal Computer.  Использование: install.sh [параметры]

  --domain NAME      свой домен (A-запись должна указывать на этот сервер); HTTPS — Let's Encrypt
  --email ADDR       почта для Let's Encrypt (необязательно)
  --no-tls           без Caddy/HTTPS: Personal Computer слушает только 127.0.0.1:${PORT}
                     (вход через SSH-туннель: ssh -L ${PORT}:127.0.0.1:${PORT} сервер → http://localhost:${PORT})
  --public-url URL   свой обратный прокси (nginx и т. п.) перед 127.0.0.1:${PORT}; вместе с --no-tls
  --port N           внутренний порт сервера (по умолчанию ${PORT})
  --root             полный доступ агента: root через sudo без пароля (то же — --with-sudo).
                     Потом переключается в настройках Personal Computer или командой «sudo personalcomputer root on|off»
  --no-root          забрать у агента root (то же — --no-sudo)
  --no-firewall      не открывать порты 80/443 в ufw/firewalld
  --ref BRANCH       ветка/тег репозитория ${REPO} (по умолчанию ${REF})
  --source DIR       взять код из локальной папки вместо GitHub
  --update           обновить код и зависимости, настройки оставить (то же — «sudo personalcomputer update» или кнопка в настройках)
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
    --root|--with-sudo) SUDO_ARG=1; shift ;;
    --no-root|--no-sudo) SUDO_ARG=0; shift ;;
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
  x86_64|amd64) NODE_ARCH=x64;    TTYD_ARCH=x86_64;  CADDY_ARCH=amd64; XRAY_ARCH=64 ;;
  aarch64|arm64) NODE_ARCH=arm64; TTYD_ARCH=aarch64; CADDY_ARCH=arm64; XRAY_ARCH=arm64-v8a ;;
  armv7l|armv7*) NODE_ARCH=armv7l; TTYD_ARCH=armhf;  CADDY_ARCH=armv7; XRAY_ARCH=arm32-v7a ;;
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
xray_sha() { case "$1" in
  64)        echo 1eb9175d0f0a8f8149c9230a7fc5ae66ce332ed20a53155ce61fe62e3f58b7df ;;
  arm64-v8a) echo 3e38d72dfc5eb65c91df0e5583e9b6676c32232041da47de6ae73946b526d66c ;;
  arm32-v7a) echo 5b2a9e2767c0197f7bd41c2db133f91440e845771e621178e0fd2b8520228e5f ;; esac; }

TMP=$(mktemp -d /tmp/personalcomputer-install.XXXXXX)
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
SERVICES="personalcomputer-runner personalcomputer-term personalcomputer"

# ---------- старые имена (mochi) ----------
LEGACY=0  # на сервере стоит версия до переименования
if { [ -d "$OLD_ETC" ] && [ ! -L "$OLD_ETC" ]; } || { [ -d "$OLD_STATE" ] && [ ! -L "$OLD_STATE" ]; } || id "$OLD-agent" >/dev/null 2>&1; then LEGACY=1; fi
# службы версии до переименования: остановить и убрать. keep-updater — службу обновления не трогаем:
# возможно, это она сейчас запустила установщик (прежнюю службу OpenRC потом уберёт personalcomputer-update legacy-cleanup)
legacy_units_off() {
  local s
  if [ "$INIT" = systemd ]; then
    for s in "$OLD-caddy" "$OLD" "$OLD-term" "$OLD-runner" "$OLD-update.path" "$OLD-access.path"; do
      systemctl disable --now -q "$s" >/dev/null 2>&1 || true
    done
    [ "${1:-}" = keep-updater ] || systemctl stop "$OLD-update.service" "$OLD-access.service" >/dev/null 2>&1 || true
    rm -rf "/etc/systemd/system/$OLD-runner.service.d" "/etc/systemd/system/$OLD-term.service.d"
    rm -f "/etc/systemd/system/$OLD.service" "/etc/systemd/system/$OLD"-*.service "/etc/systemd/system/$OLD"-*.path
    systemctl daemon-reload
  else
    for s in "$OLD-caddy" "$OLD" "$OLD-term" "$OLD-runner" "$OLD-updater"; do
      [ -e "/etc/init.d/$s" ] || continue
      rc-update del "$s" default >/dev/null 2>&1 || true
      [ "$s" = "$OLD-updater" ] && [ "${1:-}" = keep-updater ] && continue
      rc-service "$s" stop >/dev/null 2>&1 || true; rm -f "/etc/init.d/$s"
    done
  fi
}

# ---------- удаление ----------
if [ "$MODE" = uninstall ]; then
  say "Удаляю Personal Computer…"
  if [ "$INIT" = systemd ]; then UPD="personalcomputer-update.path personalcomputer-access.path"; else UPD="personalcomputer-updater"; fi
  for s in $UPD personalcomputer personalcomputer-term personalcomputer-runner personalcomputer-caddy; do svc stop "$s" >/dev/null 2>&1 || true; svc disable "$s"; done
  rm -rf /etc/systemd/system/personalcomputer-runner.service.d /etc/systemd/system/personalcomputer-term.service.d
  rm -f /etc/systemd/system/personalcomputer*.service /etc/systemd/system/personalcomputer*.path /etc/init.d/personalcomputer /etc/init.d/personalcomputer-term /etc/init.d/personalcomputer-runner /etc/init.d/personalcomputer-caddy /etc/init.d/personalcomputer-updater
  [ "$INIT" = systemd ] && systemctl daemon-reload
  rm -rf "$PREFIX" /usr/local/bin/personalcomputer /etc/sudoers.d/personalcomputer-agent
  [ "$(readlink /usr/local/bin/pc 2>/dev/null)" = personalcomputer ] && rm -f /usr/local/bin/pc
  # версия до переименования (если так и не обновлялась)
  legacy_units_off
  rm -rf "$OLD_PREFIX" "/usr/local/bin/$OLD" "/etc/sudoers.d/$OLD-agent"
  [ -L "$OLD_STATE" ] && rm -f "$OLD_STATE"
  if [ "$PURGE" = 1 ]; then
    rm -rf "$STATE" "$CADDY_HOME" "$ETC" /var/log/personalcomputer "$OLD_STATE" "$OLD_CADDY_HOME" "$OLD_ETC" "/var/log/$OLD"
    for u in personalcomputer-agent personalcomputer personalcomputer-caddy "$OLD-agent" "$OLD" "$OLD-caddy"; do userdel "$u" >/dev/null 2>&1 || deluser "$u" >/dev/null 2>&1 || true; done
    for g in personalcomputer personalcomputer-caddy "$OLD" "$OLD-caddy"; do groupdel "$g" >/dev/null 2>&1 || delgroup "$g" >/dev/null 2>&1 || true; done
    ok "Personal Computer удалён полностью, вместе с данными."
  else
    [ "$LEGACY" = 1 ] && [ ! -d "$STATE" ] && { STATE=$OLD_STATE; ETC=$OLD_ETC; }
    ok "Personal Computer удалён. Данные остались в $STATE и $ETC (удалить: --uninstall --purge)."
  fi
  exit 0
fi

# при обновлении — прежние параметры (у версии до переименования — в /etc/mochi)
CONF="$ETC/install.conf"
[ -r "$CONF" ] || [ "$LEGACY" = 0 ] || CONF="$OLD_ETC/install.conf"
if [ "$MODE" = update ] && [ -r "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
elif [ -r "$CONF" ]; then
  # повторная установка: доступ агента, переключённый в настройках, молча не сбрасываем
  WITH_SUDO=$(sed -n "s/^WITH_SUDO='\{0,1\}\([01]\)'\{0,1\}$/\1/p" "$CONF" | tail -n 1)
fi
# явный --root / --no-root важнее сохранённого
[ -n "$SUDO_ARG" ] && WITH_SUDO=$SUDO_ARG
[ "$WITH_SUDO" = 1 ] || WITH_SUDO=0
# попадают в адреса, в build.json и в install.conf — только безопасные символы
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "Неверный репозиторий: $REPO (нужно ВЛАДЕЛЕЦ/ИМЯ)"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Неверная ветка: $REF"
[ -z "$COMMIT" ] || [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Неверный PERSONALCOMPUTER_COMMIT: $COMMIT"

say "${B}Устанавливаю Personal Computer${N} · $OS_NAME · $(uname -m) · $INIT · пакеты: $PM"

# ---------- пакеты ----------
# уже стоит? (тогда менеджер пакетов не трогаем вовсе: при обновлении всё нужное обычно уже есть,
# а apt бывает занят автообновлением или сломан чужим пакетом)
have_pkg() {
  case "$PM" in
    apt-get) case "$(dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null)" in ii*) return 0 ;; esac; return 1 ;;
    dnf|yum|zypper) rpm -q --whatprovides "$1" >/dev/null 2>&1 ;;
    apk) apk info -e "$1" >/dev/null 2>&1 ;;
    pacman) pacman -Q "$1" >/dev/null 2>&1 ;;
  esac
}
pkgs_run() {
  case "$PM" in
    # занят apt (автообновление unattended-upgrades) — ждём до 10 минут, а не падаем сразу
    apt-get) export DEBIAN_FRONTEND=noninteractive
             apt-get -o DPkg::Lock::Timeout=600 update -qq || true
             apt-get -o DPkg::Lock::Timeout=600 install -y -qq --no-install-recommends "$@" ;;
    dnf) dnf install -y -q "$@" ;;
    yum) yum install -y -q "$@" ;;
    apk) apk add --no-cache -q "$@" ;;
    pacman) pacman -Sy --noconfirm --needed "$@" ;;
    zypper) zypper -n -q install --no-recommends "$@" ;;
  esac
}
PKG_LOG="$TMP/pkgs.log"
pkgs() { # pkgs ПАКЕТ… — ставит только недостающие; при ошибке её строки — в $PKG_LOG
  local need="" p
  for p in "$@"; do have_pkg "$p" || need="$need $p"; done
  [ -n "$need" ] || return 0
  # shellcheck disable=SC2086
  pkgs_run $need >"$PKG_LOG" 2>&1 && return 0
  # прерванная установка (dpkg) — доделываем и пробуем ещё раз
  if [ "$PM" = apt-get ] && grep -q 'dpkg --configure -a' "$PKG_LOG"; then
    # shellcheck disable=SC2086
    dpkg --configure -a >>"$PKG_LOG" 2>&1 && pkgs_run $need >"$PKG_LOG" 2>&1 && return 0
  fi
  return 1
}
pkg_why() { # последние строки ошибки менеджера пакетов — их видно и в окне обновления в браузере
  local l
  { grep -E '^(E:|Error|error:|ERROR)' "$PKG_LOG" 2>/dev/null || tail -n 3 "$PKG_LOG" 2>/dev/null; } | tail -n 4 | while IFS= read -r l; do warn "$l"; done
}
case "$PM" in
  apt-get) BASE="curl ca-certificates tar xz-utils gzip bash tmux git procps iproute2 passwd"; EXTRA="python3 python3-venv python3-pip build-essential unzip jq file less" ;;
  dnf|yum) BASE="curl ca-certificates tar xz gzip bash tmux git procps-ng iproute shadow-utils"; EXTRA="python3 python3-pip gcc make unzip jq file less" ;;
  apk)     BASE="curl ca-certificates tar xz gzip bash tmux git procps iproute2 shadow libstdc++ nodejs npm"; EXTRA="python3 py3-pip build-base unzip jq file less" ;;
  pacman)  BASE="curl ca-certificates tar xz gzip bash tmux git procps-ng iproute2"; EXTRA="python python-pip base-devel unzip jq file less" ;;
  zypper)  BASE="curl ca-certificates tar xz gzip bash tmux git procps iproute2 shadow"; EXTRA="python3 python3-pip gcc make unzip jq file less" ;;
esac
# sudo — для полного доступа агента: его можно включить в любой момент из настроек
BASE="$BASE sudo"
say "Ставлю системные пакеты…"
# shellcheck disable=SC2086
pkgs $BASE || { pkg_why; die "Не удалось поставить пакеты:$(for p in $BASE; do have_pkg "$p" || printf ' %s' "$p"; done) (причина — строки выше)"; }
# необязательное — инструменты для агента; без них всё равно работает
# shellcheck disable=SC2086
pkgs $EXTRA 2>/dev/null || warn "Часть дополнительных пакетов не поставилась ($EXTRA) — не страшно"
ok "Пакеты на месте"

# переезд: программа (Node.js, ttyd, Caddy, код) — сразу на новое место, чтобы не качать её заново.
# По старому пути — ссылка: службы прежней версии пока работают и не должны этого заметить
if [ "$LEGACY" = 1 ] && [ -d "$OLD_PREFIX" ] && [ ! -L "$OLD_PREFIX" ] && [ ! -e "$PREFIX" ]; then
  mv "$OLD_PREFIX" "$PREFIX" && ln -s "$PREFIX" "$OLD_PREFIX"
fi
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

# ---------- Xray: прокси vless/vmess/trojan/ss/hysteria2 (настройки → Сервер → «Прокси») ----------
# необязательный: не скачался — Personal Computer работает и без него (прокси socks5/http — тоже), Xray встанет при следующем обновлении
unzip_one() { # unzip_one АРХИВ ФАЙЛ ПАПКА — достать один файл из zip: unzip, busybox, python3 или bsdtar — что найдётся
  if command -v unzip >/dev/null 2>&1; then unzip -o -q "$1" "$2" -d "$3"
  elif command -v busybox >/dev/null 2>&1 && busybox --list 2>/dev/null | grep -qx unzip; then busybox unzip -o -q "$1" "$2" -d "$3"
  elif command -v python3 >/dev/null 2>&1; then python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract(sys.argv[2], sys.argv[3])' "$1" "$2" "$3"
  elif command -v bsdtar >/dev/null 2>&1; then bsdtar -xf "$1" -C "$3" "$2"
  else return 1; fi
}
if [ -x "$PREFIX/bin/xray" ] && "$PREFIX/bin/xray" version 2>/dev/null | grep -q "^Xray $XRAY_VER "; then ok "Xray $XRAY_VER уже стоит"
else
  say "Скачиваю Xray $XRAY_VER (прокси)…"
  f="Xray-linux-${XRAY_ARCH}.zip"
  if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 20 -o "$TMP/$f" "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VER}/$f"; then
    warn "Xray не скачался — прокси vless/vmess/trojan/ss/hysteria2 заработает после следующего обновления (socks5 и http работают и так)"
  elif ! sum_ok sha256 "$(xray_sha "$XRAY_ARCH")" "$TMP/$f"; then
    warn "Контрольная сумма Xray не совпала — не ставлю его! Прокси vless/vmess/trojan/ss/hysteria2 пока недоступен"
  elif mkdir -p "$TMP/xray" && unzip_one "$TMP/$f" xray "$TMP/xray" && [ -s "$TMP/xray/xray" ]; then
    install -m 0755 "$TMP/xray/xray" "$PREFIX/bin/xray"
    ok "Xray $XRAY_VER"
  else
    warn "Не получилось распаковать Xray: нужен unzip (поставь его и запусти обновление ещё раз)"
  fi
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
    # порты держит наш же Caddy — в том числе прежний mochi-caddy (до переименования): его остановит переезд ниже
    ours=0
    for c in personalcomputer-caddy "$OLD-caddy"; do
      if [ "$INIT" = systemd ]; then systemctl is-active -q "$c" 2>/dev/null && ours=1; else rc-service "$c" status >/dev/null 2>&1 && ours=1; fi
    done
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

# ---------- код Personal Computer ----------
say "Ставлю код Personal Computer…"
here=""; [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -z "$SRC" ] && [ -n "$here" ] && [ -f "$here/server/personalcomputer.js" ] && [ -f "$here/index.html" ]; then SRC="$here"; fi
BUILD_COMMIT=""  # коммит, из которого ставим: по нему сервер проверяет, есть ли обновление
if [ -z "$SRC" ]; then
  fetch "https://codeload.github.com/${REPO}/tar.gz/${COMMIT:-$REF}" "$TMP/src.tgz" || die "Не скачался код ${REPO}@${COMMIT:-$REF}"
  gzip -dc "$TMP/src.tgz" > "$TMP/src.tar" || die "Архив с кодом повреждён — запусти ещё раз"
  mkdir -p "$TMP/src"; tar -xf "$TMP/src.tar" -C "$TMP/src" --strip-components=1
  # GitHub собирает архив через git archive и пишет коммит в его заголовок: «comment=<sha>»
  BUILD_COMMIT=$(head -c 1024 "$TMP/src.tar" | tr -c '0-9a-z=\n' '\n' | sed -n 's/^comment=\([0-9a-f]\{40\}\)$/\1/p' | sed -n 1p)
  rm -f "$TMP/src.tar" "$TMP/src.tgz"
  SRC="$TMP/src"
elif [ -e "$SRC/.git" ] && command -v git >/dev/null 2>&1; then
  BUILD_COMMIT=$(git -c safe.directory='*' -C "$SRC" rev-parse HEAD 2>/dev/null || true)
fi
[[ "$BUILD_COMMIT" =~ ^[0-9a-f]{40}$ ]] || BUILD_COMMIT=""
[ -f "$SRC/server/personalcomputer.js" ] && [ -f "$SRC/index.html" ] || die "В $SRC нет server/personalcomputer.js — это точно код Personal Computer?"
rm -rf "$PREFIX/app.new"; mkdir -p "$PREFIX/app.new"
cp -r "$SRC/index.html" "$SRC/sw.js" "$SRC/manifest.webmanifest" "$SRC/icons" "$SRC/server" "$PREFIX/app.new/"
rm -rf "$PREFIX/app.new/server/test" "$PREFIX/app.new/server/.dev"
printf '{"repo":"%s","ref":"%s","commit":"%s","installed":"%s"}\n' "$REPO" "$REF" "$BUILD_COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$PREFIX/app.new/build.json"
chmod -R u=rwX,go=rX "$PREFIX/app.new"; chmod 0755 "$PREFIX/app.new/server/bin/"*
"$NODE" --check "$PREFIX/app.new/server/personalcomputer.js" || die "Код не прошёл проверку синтаксиса"
rm -rf "$PREFIX/app.old"; [ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$PREFIX/app.new" "$PREFIX/app"
ok "Код: $(cd "$PREFIX/app/server" && "$NODE" -p 'require("./package.json").version')${BUILD_COMMIT:+ · ${BUILD_COMMIT:0:7}}"

# ---------- переезд со старых имён ----------
# Пользователей и группы переименовываем (UID и GID прежние — владельцы файлов не меняются), папки переносим
# как есть: данные, чаты, ключи, сертификаты и рабочие папки агента остаются на месте
rename_user() { # старое новое домашняя-папка описание
  id "$1" >/dev/null 2>&1 || return 0
  id "$2" >/dev/null 2>&1 && return 0
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    # процессы пользователя (фоновые задачи агента, tmux) мешают переименованию
    pkill -KILL -u "$1" >/dev/null 2>&1 || true
    usermod -l "$2" -d "$3" -c "$4" "$1" >/dev/null 2>&1 && return 0
    sleep "$i"
  done
  die "Не получилось переименовать пользователя $1 в $2 (usermod) — посмотри, что ещё работает: ps -u $1"
}
rename_group() { # старое новое
  getent group "$1" >/dev/null || return 0
  getent group "$2" >/dev/null && return 0
  groupmod -n "$2" "$1" || die "Не получилось переименовать группу $1 в $2 (groupmod)"
}
move_dir() { # старая новая [link]
  { [ -d "$1" ] && [ ! -L "$1" ]; } || return 0
  if [ -e "$2" ]; then warn "$2 уже есть — $1 оставляю как есть"; return 0; fi
  mv "$1" "$2"
  if [ "${3:-}" = link ]; then ln -s "$2" "$1"; fi
}
if [ "$LEGACY" = 1 ]; then
  say "Переезжаю со старого имени mochi: пользователи, папки, службы…"
  if [ -n "$UPDATER" ]; then legacy_units_off keep-updater; else legacy_units_off; fi
  for u in "$OLD-agent" "$OLD" "$OLD-caddy"; do pkill -TERM -u "$u" >/dev/null 2>&1 || true; done
  sleep 1
  rename_group "$OLD" personalcomputer
  rename_group "$OLD-caddy" personalcomputer-caddy
  rename_user "$OLD-agent" personalcomputer-agent "$STATE/agent" "Personal Computer agent"
  rename_user "$OLD" personalcomputer "$STATE" "Personal Computer server"
  rename_user "$OLD-caddy" personalcomputer-caddy "$CADDY_HOME" "Personal Computer HTTPS"
  # по старому пути — ссылка: прежняя служба обновления (если установщик запустила она) пишет туда ход работы.
  # Ссылки убирает personalcomputer-update legacy-cleanup, когда она закончит
  move_dir "$OLD_STATE" "$STATE" link
  move_dir "$OLD_CADDY_HOME" "$CADDY_HOME"
  move_dir "$OLD_ETC" "$ETC"
  move_dir "/var/log/$OLD" /var/log/personalcomputer
  rm -f "$ETC/$OLD.env"  # personalcomputer.env пишется ниже заново
  move_dir "$STATE/agent/.local/state/$OLD" "$STATE/agent/.local/state/personalcomputer"
  [ -f "$STATE/agent/.profile" ] && sed -i "s#$OLD_PREFIX/#$PREFIX/#g" "$STATE/agent/.profile"
  # расписания cron агента (Debian/Ubuntu, Fedora/RHEL, Alpine)
  for d in /var/spool/cron/crontabs /var/spool/cron /etc/crontabs; do
    [ -f "$d/$OLD-agent" ] && [ ! -e "$d/personalcomputer-agent" ] && mv "$d/$OLD-agent" "$d/personalcomputer-agent"
  done
  # правило sudo и drop-in'ы пишет заново personalcomputer-access (ниже) — по сохранённому выбору
  rm -f "/etc/sudoers.d/$OLD-agent" "/usr/local/bin/$OLD"
  ok "Переезд готов: всё называется personalcomputer, данные на месте"
fi

# ---------- пользователи ----------
NOLOGIN=$(command -v nologin || echo /bin/false)
getent group personalcomputer >/dev/null || groupadd --system personalcomputer
id personalcomputer >/dev/null 2>&1 || useradd --system --gid personalcomputer --home-dir "$STATE" --no-create-home --shell "$NOLOGIN" --comment "Personal Computer server" personalcomputer
id personalcomputer-agent >/dev/null 2>&1 || useradd --system --gid personalcomputer --home-dir "$STATE/agent" --no-create-home --shell /bin/bash --comment "Personal Computer agent" personalcomputer-agent
if [ "$TLS" = on ]; then
  getent group personalcomputer-caddy >/dev/null || groupadd --system personalcomputer-caddy
  id personalcomputer-caddy >/dev/null 2>&1 || useradd --system --gid personalcomputer-caddy --home-dir "$CADDY_HOME" --no-create-home --shell "$NOLOGIN" --comment "Personal Computer HTTPS" personalcomputer-caddy
fi
# агент может разблокироваться и после «usermod -L»: пароль у системных пользователей не задан
passwd -l personalcomputer-agent >/dev/null 2>&1 || true

# папки: права выставляем и при повторной установке
mkd() { mkdir -p "$3"; chown "$2" "$3"; chmod "$1" "$3"; }
mkd 0750 root:personalcomputer "$STATE"
mkd 0700 personalcomputer:personalcomputer "$STATE/data"
mkd 2770 personalcomputer-agent:personalcomputer "$STATE/agent"
mkd 0755 root:root "$ETC"  # секретов здесь нет; Caddyfile читает personalcomputer-caddy
mkd 0755 root:root /var/log/personalcomputer
mkd 0750 root:personalcomputer "$STATE/update"  # ход обновления (пишет root, читает сервер)
A="$STATE/agent"
mkd 0750 personalcomputer-agent:personalcomputer "$A/.local"
mkd 0750 personalcomputer-agent:personalcomputer "$A/.local/bin"
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
chown personalcomputer-agent:personalcomputer "$A/.profile"; }
chmod 0640 "$A/.profile" 2>/dev/null || true
# swap_line ФАЙЛ СТАРАЯ НОВАЯ — заменить строку, если она в файле ровно такая (её писал прежний установщик);
# остальное в файле не трогаем, владелец и права остаются прежними
swap_line() {
  [ -f "$1" ] && grep -qxF -- "$2" "$1" || return 0
  O="$2" N="$3" awk '$0 == ENVIRON["O"] { print ENVIRON["N"]; next } { print }' "$1" > "$TMP/swap" && cat "$TMP/swap" > "$1"
}
PS1_PC='PS1="\[\e[35m\]pc\[\e[0m\]:\[\e[32m\]\w\[\e[0m\]\$ "'
README_PC="Это рабочая папка агента Personal Computer."
[ -f "$A/.bashrc" ] || { printf '%s\n' "$PS1_PC" 'alias ll="ls -la"' > "$A/.bashrc"; chown personalcomputer-agent:personalcomputer "$A/.bashrc"; }
# приглашение «мочи:~$» и README из версий до переименования
swap_line "$A/.bashrc" 'PS1="\[\e[35m\]мочи\[\e[0m\]:\[\e[32m\]\w\[\e[0m\]\$ "' "$PS1_PC"
swap_line "$A/README.txt" "Это рабочая папка агента Мочи." "$README_PC"
chmod 0640 "$A/.bashrc" 2>/dev/null || true
[ -f "$A/README.txt" ] || { printf '%s\n' "$README_PC" "Папки пользователей: <имя>/inbox (файлы от пользователя), <имя>/outbox (результаты)." > "$A/README.txt"; chown personalcomputer-agent:personalcomputer "$A/README.txt"; }
chmod 0640 "$A/README.txt" 2>/dev/null || true

# ---------- настройки ----------
cat > "$ETC/personalcomputer.env" <<EOF
# Настройки Personal Computer (после правки: sudo personalcomputer restart). Секретов здесь нет.
PERSONALCOMPUTER_HOST=127.0.0.1
PERSONALCOMPUTER_PORT=$PORT
PERSONALCOMPUTER_DATA=$STATE/data
PERSONALCOMPUTER_WORK=$STATE/agent
PERSONALCOMPUTER_WEB=$PREFIX/app
PERSONALCOMPUTER_PUBLIC_URL=$PUBLIC_URL
PERSONALCOMPUTER_SECURE_COOKIE=$SECURE
PERSONALCOMPUTER_TRUST_PROXY=$TRUST
PERSONALCOMPUTER_AGENT_SUDO=$WITH_SUDO
PERSONALCOMPUTER_RUNNER_SOCK=/run/personalcomputer-runner/runner.sock
PERSONALCOMPUTER_TTYD_SOCK=/run/personalcomputer-term/ttyd.sock
PERSONALCOMPUTER_TTYD_BIN=$PREFIX/bin/ttyd
PERSONALCOMPUTER_XRAY=$PREFIX/bin/xray
PERSONALCOMPUTER_UPDATE_DIR=$STATE/update
PERSONALCOMPUTER_ACCESS_CTL=1
EOF
chmod 0640 "$ETC/personalcomputer.env"; chown root:personalcomputer "$ETC/personalcomputer.env"
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

# ---------- доступ агента ----------
# root через sudo без пароля: правило sudoers и drop-in, снимающий изоляцию исполнителя и терминала
# (сами службы ниже всегда изолированы). Это делает personalcomputer-access — тот же, что переключает доступ из настроек
if [ "$WITH_SUDO" = 1 ]; then ROOTW=on; else ROOTW=off; fi
"$PREFIX/app/server/bin/personalcomputer-access" apply "$ROOTW" --no-restart || warn "Доступ агента не переключился (подробности выше). Повторить: sudo personalcomputer root $ROOTW"

if [ "$TLS" = on ]; then
  mkd 0700 personalcomputer-caddy:personalcomputer-caddy "$CADDY_HOME"
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
  SERVICES="$SERVICES personalcomputer-caddy"
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
  # агент — обычный пользователь без доступа к данным сервера и домашним папкам людей.
  # Полный доступ (root) снимает это drop-in'ом personalcomputer-*.service.d/personalcomputer-root.conf (его пишет personalcomputer-access)
  HARD_AGENT="NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
InaccessiblePaths=-$STATE/data
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes"

  cat > /etc/systemd/system/personalcomputer-runner.service <<EOF
[Unit]
Description=Personal Computer — исполнитель команд агента
After=network-online.target
Wants=network-online.target

[Service]
User=personalcomputer-agent
Group=personalcomputer
EnvironmentFile=$ETC/personalcomputer.env
Environment=HOME=$STATE/agent
WorkingDirectory=$STATE/agent
ExecStart=$NODE $APP/personalcomputer.js runner
RuntimeDirectory=personalcomputer-runner
RuntimeDirectoryMode=0750
UMask=0007
Restart=always
RestartSec=2
KillMode=control-group
$HARD_AGENT

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/personalcomputer-term.service <<EOF
[Unit]
Description=Personal Computer — терминал (ttyd на unix-сокете)
After=network-online.target

[Service]
User=personalcomputer-agent
Group=personalcomputer
EnvironmentFile=$ETC/personalcomputer.env
Environment=HOME=$STATE/agent SHELL=/bin/bash
WorkingDirectory=$STATE/agent
ExecStart=$APP/bin/personalcomputer-ttyd
RuntimeDirectory=personalcomputer-term
RuntimeDirectoryMode=0750
UMask=0007
Restart=always
RestartSec=2
$HARD_AGENT

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/personalcomputer.service <<EOF
[Unit]
Description=Personal Computer — облачный агент (веб, API, Telegram)
After=network-online.target personalcomputer-runner.service personalcomputer-term.service
Wants=network-online.target personalcomputer-runner.service personalcomputer-term.service

[Service]
User=personalcomputer
Group=personalcomputer
EnvironmentFile=$ETC/personalcomputer.env
WorkingDirectory=$STATE/data
ExecStart=$NODE $APP/personalcomputer.js serve
UMask=0007
Restart=always
RestartSec=2
TimeoutStopSec=15
$HARD_SERVER

[Install]
WantedBy=multi-user.target
EOF
  if [ "$TLS" = on ]; then
    cat > /etc/systemd/system/personalcomputer-caddy.service <<EOF
[Unit]
Description=Personal Computer — HTTPS (Caddy)
After=network-online.target personalcomputer.service
Wants=network-online.target

[Service]
User=personalcomputer-caddy
Group=personalcomputer-caddy
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
    systemctl disable --now personalcomputer-caddy >/dev/null 2>&1 || true; rm -f /etc/systemd/system/personalcomputer-caddy.service
  fi
  # кнопка «Обновить» в браузере: сервер (без прав) кладёт файл-запрос, systemd замечает его
  # и запускает обновление от root. Что и откуда ставить, решает только personalcomputer-update (из install.conf)
  cat > /etc/systemd/system/personalcomputer-update.service <<EOF
[Unit]
Description=Personal Computer — обновление (по кнопке в настройках)

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=$APP/bin/personalcomputer-update service
TimeoutStartSec=30min
EOF
  cat > /etc/systemd/system/personalcomputer-update.path <<EOF
[Unit]
Description=Personal Computer — ждёт запрос на обновление из настроек

[Path]
PathExists=$STATE/data/update.request
Unit=personalcomputer-update.service

[Install]
WantedBy=multi-user.target
EOF
  # переключатель «Доступ агента» в настройках: так же — файл-запрос сервера и root-служба
  cat > /etc/systemd/system/personalcomputer-access.service <<EOF
[Unit]
Description=Personal Computer — доступ агента (root вкл/выкл из настроек)

[Service]
Type=oneshot
Environment=HOME=/root
ExecStart=$APP/bin/personalcomputer-access service
TimeoutStartSec=40min
EOF
  cat > /etc/systemd/system/personalcomputer-access.path <<EOF
[Unit]
Description=Personal Computer — ждёт запрос на смену доступа агента из настроек

[Path]
PathExists=$STATE/data/access.request
Unit=personalcomputer-access.service

[Install]
WantedBy=multi-user.target
EOF
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
command_args="-c 'umask 007; set -a; . $ETC/personalcomputer.env; $envs; set +a; exec $cmd'"
command_user="$ug"
directory="$wd"
output_log="/var/log/personalcomputer/$n.log"
error_log="/var/log/personalcomputer/$n.log"
respawn_delay=2
respawn_max=0
depend() {
	use net dns
	after net firewall
	${deps:-:}
}
start_pre() {
	${rt:+checkpath -d -m 0750 -o $ug /run/$rt}
	checkpath -f -m 0640 -o $ug /var/log/personalcomputer/$n.log
}
EOF
    chmod 0755 "/etc/init.d/$n"
  }
  orc personalcomputer-runner personalcomputer-agent:personalcomputer "Personal Computer — исполнитель команд" personalcomputer-runner "$STATE/agent" "HOME=$STATE/agent" "$NODE $APP/personalcomputer.js runner"
  orc personalcomputer-term personalcomputer-agent:personalcomputer "Personal Computer — терминал" personalcomputer-term "$STATE/agent" "HOME=$STATE/agent SHELL=/bin/bash" "$APP/bin/personalcomputer-ttyd"
  orc personalcomputer personalcomputer:personalcomputer "Personal Computer — облачный агент" "" "$STATE/data" "HOME=$STATE" "$NODE $APP/personalcomputer.js serve" "after personalcomputer-runner personalcomputer-term"
  if [ "$TLS" = on ]; then
    command -v setcap >/dev/null 2>&1 || pkgs libcap-setcap >/dev/null 2>&1 || pkgs libcap >/dev/null 2>&1 || true
    setcap cap_net_bind_service=+ep "$PREFIX/bin/caddy" || die "Не удалось разрешить Caddy порты 80/443 (нужен setcap)"
    orc personalcomputer-caddy personalcomputer-caddy:personalcomputer-caddy "Personal Computer — HTTPS" "" "$CADDY_HOME" "HOME=$CADDY_HOME XDG_DATA_HOME=$CADDY_HOME XDG_CONFIG_HOME=$CADDY_HOME" "$PREFIX/bin/caddy run --config $ETC/Caddyfile --adapter caddyfile" "after personalcomputer"
  fi
  # кнопки «Обновить» и «Доступ агента» в браузере: следит за файлами-запросами сервера и выполняет их от root
  orc personalcomputer-updater root:root "Personal Computer — обновление и доступ агента по кнопкам в настройках" "" "$STATE" "HOME=/root" "$APP/bin/personalcomputer-update watch"
fi

# ---------- команда personalcomputer ----------
cat > /usr/local/bin/personalcomputer <<EOF
#!/bin/sh
# Управление Personal Computer. Подробнее: personalcomputer help
INIT=$INIT
NODE=$NODE
APP=$APP
SERVICES="$SERVICES"
REPO="$REPO"
REF="$REF"
EOF
cat >> /usr/local/bin/personalcomputer <<'EOF'
need_root() { [ "$(id -u)" -eq 0 ] || { echo "Нужно через sudo: sudo personalcomputer $*" >&2; exit 1; }; }
each() { for s in $SERVICES; do if [ "$INIT" = systemd ]; then systemctl "$1" "$s"; else rc-service "$s" "$1"; fi; done; }
# команда из исполнителя или терминала Personal Computer (агент с root): перезапуск их служб оборвал бы её на полпути
inside() { grep -qE 'personalcomputer-(runner|term)' /proc/self/cgroup 2>/dev/null; }
case "${1:-help}" in
  start|stop|restart)
    need_root "$@"
    if [ "$INIT" = systemd ] && inside; then
      # shellcheck disable=SC2086
      systemctl "$1" --no-block $SERVICES && echo "Готово: службы Personal Computer перезапускаются (эта команда оборвётся вместе с ними — это нормально)"
    else each "$1"; fi ;;
  logs)
    if [ "$INIT" = systemd ]; then shift; exec journalctl -u 'personalcomputer*' -n 200 "${@:--f}"; else exec tail -n 200 -f /var/log/personalcomputer/*.log; fi ;;
  update) need_root "$@"; exec "$APP/bin/personalcomputer-update" cli ;;
  root) need_root "$@"; exec "$APP/bin/personalcomputer-access" cli "${2:-status}" ;;
  uninstall) need_root "$@"; shift; curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/install.sh" | bash -s -- --uninstall "$@" ;;
  status)
    for s in $SERVICES; do
      if [ "$INIT" = systemd ]; then printf '%-24s %s\n' "$s" "$(systemctl is-active "$s")"; else printf '%-24s ' "$s"; rc-service "$s" status 2>/dev/null | tail -1; fi
    done
    [ "$(id -u)" -eq 0 ] && { set -a; . /etc/personalcomputer/personalcomputer.env; set +a; "$NODE" "$APP/personalcomputer.js" status; } ;;
  invite|users|passwd|admin|deluser)
    need_root "$@"; set -a; . /etc/personalcomputer/personalcomputer.env; set +a; exec "$NODE" "$APP/personalcomputer.js" "$@" ;;
  *)
    cat <<'H'
personalcomputer invite [дней]     — ссылка-приглашение для регистрации
personalcomputer users             — пользователи
personalcomputer passwd <имя>      — сбросить пароль (новый будет напечатан)
personalcomputer admin <имя> [off] — сделать (снять) администратора
personalcomputer deluser <имя>     — удалить пользователя
personalcomputer status | logs     — состояние и журнал
personalcomputer start | stop | restart
personalcomputer update            — обновить Personal Computer (данные сохраняются; то же — кнопка в настройках → Сервер)
personalcomputer root [on|off]     — полный доступ агента: root через sudo без пароля (то же — настройки → Сервер)
personalcomputer uninstall [--purge]
Коротко — pc: например, sudo pc root on
H
    ;;
esac
EOF
chmod 0755 /usr/local/bin/personalcomputer
# короткое имя — как метка [pc] в терминале. Чужую команду pc не заслоняем
if [ "$(readlink /usr/local/bin/pc 2>/dev/null)" = personalcomputer ] || ! command -v pc >/dev/null 2>&1; then
  ln -sfn personalcomputer /usr/local/bin/pc
fi

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
# служба обновления по кнопке. Если обновляет она сама ($UPDATER), её не перезапускаем — это оборвало бы обновление
if [ "$INIT" = systemd ]; then UPD=personalcomputer-update.path; else UPD=personalcomputer-updater; fi
svc enable "$UPD"
if [ -n "$UPDATER" ]; then svc start "$UPD" >/dev/null 2>&1 || true
else svc restart "$UPD" >/dev/null 2>&1 || svc start "$UPD" >/dev/null 2>&1 || warn "Не запустилась служба $UPD — обновлять можно командой: sudo personalcomputer update"; fi
if [ "$INIT" = systemd ]; then
  svc enable personalcomputer-access.path
  svc restart personalcomputer-access.path >/dev/null 2>&1 || warn "Не запустилась служба personalcomputer-access.path — доступ агента можно переключать командой: sudo personalcomputer root on|off"
fi
# после переезда: ссылки со старых путей и прежняя служба обновления OpenRC больше не нужны. Если установщик
# запустила прежняя служба обновления, она ещё пишет по старому пути — тогда уберём чуть позже
# (systemd — таймером; OpenRC — служба personalcomputer-updater, как только прежнее обновление закончится)
if [ -L "$OLD_PREFIX" ] || [ -L "$OLD_STATE" ] || [ -e "/etc/init.d/$OLD-updater" ]; then
  if [ -z "$UPDATER" ]; then "$APP/bin/personalcomputer-update" legacy-cleanup || true
  elif [ "$INIT" = systemd ]; then
    systemd-run -q --on-active=90 --unit="personalcomputer-legacy-cleanup-$(date +%s)" "$APP/bin/personalcomputer-update" legacy-cleanup >/dev/null 2>&1 || true
  fi
fi

up=0
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && { up=1; break; }; sleep 0.5; done
if [ "$up" != 1 ]; then
  [ "$INIT" = systemd ] && journalctl -u personalcomputer -n 30 --no-pager >&2 || tail -n 30 /var/log/personalcomputer/personalcomputer.log >&2 || true
  die "Сервер Personal Computer не запустился (журнал выше; подробнее: personalcomputer logs)"
fi
ok "Сервер Personal Computer работает"

set -a; . "$ETC/personalcomputer.env"; set +a
nusers=$("$NODE" "$APP/personalcomputer.js" status 2>/dev/null | grep -oE '"users": *[0-9]+' | grep -oE '[0-9]+$' || echo 0)

URL="${PUBLIC_URL:-http://localhost:$PORT}"
if [ "$TLS" = on ]; then
  say "Получаю HTTPS-сертификат для $DOMAIN (до 1,5 минуты)…"
  tls=0
  for _ in $(seq 1 45); do curl -fsS --max-time 5 "https://$DOMAIN/api/health" >/dev/null 2>&1 && { tls=1; break; }; sleep 2; done
  if [ "$tls" = 1 ]; then ok "HTTPS готов"
  else warn "HTTPS пока не отвечает. Проверь: порты 80 и 443 открыты у хостера (облачный firewall), домен $DOMAIN указывает на этот сервер. Журнал: personalcomputer logs"; fi
fi

echo
printf '%s\n' "${B}${P}  ╭─────────────────────────────────────────────╮${N}"
printf '%s\n' "${B}${P}  │   Personal Computer установлен!  [^_^]       │${N}"
printf '%s\n' "${B}${P}  ╰─────────────────────────────────────────────╯${N}"
if [ "${nusers:-0}" = 0 ]; then
  inv=$("$NODE" "$APP/personalcomputer.js" invite 7 | grep -oE '[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}' | head -1)
  echo
  echo "  Открой и зарегистрируйся (первый пользователь станет администратором):"
  echo
  echo "    ${B}${URL}/?invite=${inv}${N}"
  echo
  echo "  Код приглашения: ${B}${inv}${N}  (одноразовый, 7 дней; новый: sudo personalcomputer invite)"
else
  echo; echo "  Адрес: ${B}${URL}/${N}   (пользователей: $nusers)"
fi
if [ "$TLS" = off ] && [ -z "$PUBLIC_URL" ]; then
  echo
  echo "  Personal Computer слушает только 127.0.0.1. С компьютера: ssh -L $PORT:127.0.0.1:$PORT $(id -un 2>/dev/null)@<сервер>"
  echo "  и открой http://localhost:$PORT"
fi
echo
echo "  Дальше: в настройках Personal Computer → «Модель» — вставь ключ API. Telegram: попроси в чате «подключи Telegram»."
if [ "$WITH_SUDO" = 1 ]; then
  echo "  ${Y}У агента полный доступ: root через sudo без пароля.${N} Забрать: ${B}sudo personalcomputer root off${N}"
else
  echo "  Агент работает без root. Полный доступ: настройки → Сервер → «Доступ агента» или ${B}sudo personalcomputer root on${N}"
fi
echo "  Управление: ${B}personalcomputer help${N}"
echo
