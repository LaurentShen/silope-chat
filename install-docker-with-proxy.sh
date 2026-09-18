#!/usr/bin/env bash
# Install Docker Engine + Compose from Docker's official apt repository.
# Ubuntu 22.04/24.04/26.04 or Debian 12/13 on a systemd server.
# Safe to run again. Existing Docker is not upgraded or removed.
# Usage: sudo bash install-docker-with-proxy.sh
#        sudo DOCKER_PROXY=http://192.0.2.10:7890 bash install-docker-with-proxy.sh
# Optional: DOCKER_NO_PROXY=localhost,127.0.0.1,::1,.internal
# Optional: VERIFY_PULL=0 to skip pulling hello-world after installation.
set -Eeuo pipefail

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'Run with sudo or as root.'
command -v apt-get >/dev/null || die 'Only Ubuntu and Debian with apt are supported.'
command -v systemctl >/dev/null || die 'A normal systemd server is required.'
[[ -f /etc/os-release ]] || die 'Cannot identify operating system.'
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|ubuntu:26.04|debian:12|debian:13) ;;
  *) die "Unsupported OS: $ID $VERSION_ID (use official instructions for this OS)." ;;
esac
[[ -n ${VERSION_CODENAME:-} ]] || die 'Missing VERSION_CODENAME.'
codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}
case "$ID:$codename" in
  ubuntu:jammy|ubuntu:noble|ubuntu:resolute|debian:bookworm|debian:trixie) ;;
  *) die "Unexpected distribution codename: $codename" ;;
esac

installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -qx 'install ok installed'; }
if installed docker-ce; then
  printf 'Docker Engine is already installed; retaining its current version.\n'
else
  for pkg in docker.io docker-compose docker-compose-v2 podman-docker containerd containerd.io runc; do
    if installed "$pkg"; then
      die "Conflicting package $pkg found. Resolve it manually before installing Docker CE."
    fi
  done
  if command -v dockerd >/dev/null; then
    die 'An existing Docker daemon was found outside the docker-ce package; no changes made.'
  fi
fi

proxy=${DOCKER_PROXY:-}
no_proxy=${DOCKER_NO_PROXY:-localhost,127.0.0.1,::1}
verify=${VERIFY_PULL:-1}
[[ $verify == 0 || $verify == 1 ]] || die 'VERIFY_PULL must be 0 or 1.'
apt_proxy_args=()
curl_proxy_args=()
if [[ -n $proxy ]]; then
  [[ $proxy == http://* || $proxy == https://* ]] || die 'DOCKER_PROXY must start with http:// or https:// (an HTTP CONNECT proxy).'
  apt_proxy_args=(-o "Acquire::http::Proxy=$proxy" -o "Acquire::https::Proxy=$proxy")
  curl_proxy_args=(--proxy "$proxy")
  printf 'Using the configured HTTP proxy for downloads and Docker image pulls.\n'
else
  printf 'Using direct internet access for downloads.\n'
fi

export DEBIAN_FRONTEND=noninteractive
need_repo=0
if ! installed docker-ce || ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
  need_repo=1
fi
if (( need_repo )); then
  apt-get "${apt_proxy_args[@]}" update
  apt-get "${apt_proxy_args[@]}" install -y ca-certificates curl python3
  install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
    curl -fsSL --retry 3 "${curl_proxy_args[@]}" "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi
  if [[ ! -e /etc/apt/sources.list.d/docker.sources ]]; then
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  fi
  apt-get "${apt_proxy_args[@]}" update
  if ! installed docker-ce; then
    apt-get "${apt_proxy_args[@]}" install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    missing=()
    installed docker-buildx-plugin || missing+=(docker-buildx-plugin)
    installed docker-compose-plugin || missing+=(docker-compose-plugin)
    if ((${#missing[@]})); then apt-get "${apt_proxy_args[@]}" install -y "${missing[@]}"; fi
  fi
fi

config_changed=0
if [[ -n $proxy ]]; then
  if ! command -v python3 >/dev/null; then
    apt-get "${apt_proxy_args[@]}" update
    apt-get "${apt_proxy_args[@]}" install -y python3
  fi
  install -m 0700 -d /etc/docker
  backup="/etc/docker/daemon.json.bak.$(date +%Y%m%d%H%M%S)-$$"
  # Keep unrelated daemon settings. Save a backup only if this proxy changes.
  config_changed=$(DOCKER_PROXY="$proxy" DOCKER_NO_PROXY="$no_proxy" BACKUP_PATH="$backup" python3 - <<'PY'
import json, os, shutil, tempfile
from pathlib import Path

path = Path('/etc/docker/daemon.json')
old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
if not isinstance(old, dict):
    raise SystemExit('daemon.json must contain a JSON object')
new = dict(old)
proxies = dict(new.get('proxies') or {})
proxies.update({
    'http-proxy': os.environ['DOCKER_PROXY'],
    'https-proxy': os.environ['DOCKER_PROXY'],
    'no-proxy': os.environ['DOCKER_NO_PROXY'],
})
new['proxies'] = proxies
if new == old:
    print('0')
else:
    if path.exists():
        shutil.copy2(path, os.environ['BACKUP_PATH'])
        os.chmod(os.environ['BACKUP_PATH'], 0o600)
    fd, temp = tempfile.mkstemp(prefix='.daemon-', suffix='.json', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(new, output, indent=2)
            output.write('\n')
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)
    print('1')
PY
  )
fi

if ! systemctl enable --now docker; then
  if [[ $config_changed == 1 ]]; then
    if [[ -f $backup ]]; then cp -p "$backup" /etc/docker/daemon.json
    else rm -f /etc/docker/daemon.json; fi
    systemctl start docker || true
  fi
  die 'Docker service did not start; inspect journalctl -u docker.'
fi
if [[ $config_changed == 1 ]]; then
  printf 'Docker proxy changed; restarting Docker daemon (running containers may briefly disconnect).\n'
  if ! systemctl restart docker; then
    if [[ -f $backup ]]; then cp -p "$backup" /etc/docker/daemon.json
    else rm -f /etc/docker/daemon.json; fi
    systemctl restart docker || true
    die 'Docker rejected the new configuration; previous daemon.json restored.'
  fi
fi
systemctl is-active --quiet docker || die 'Docker service did not start; inspect journalctl -u docker.'
docker version --format 'Docker client {{.Client.Version}} / server {{.Server.Version}}'
docker compose version
if [[ $verify == 1 ]]; then docker run --rm hello-world; fi
printf '\nDone. Docker Engine and Compose are ready.\n'
printf 'Docker daemon proxy applies to image pulls; container applications and Dockerfile RUN steps may need separate proxy settings.\n'
