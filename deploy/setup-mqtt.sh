#!/usr/bin/env bash

set -euo pipefail

deployment_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
environment_file="${deployment_dir}/.env"
password_file="${deployment_dir}/mosquitto/config/passwd"

if [[ -e "${environment_file}" || -e "${password_file}" ]]; then
  echo "Refusing to overwrite existing MQTT credentials." >&2
  echo "Remove ${environment_file} and ${password_file} explicitly to rotate them." >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required." >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "OpenSSL is required." >&2
  exit 1
}

umask 077
mkdir -p "${deployment_dir}/mosquitto/config" "${deployment_dir}/mosquitto/data"

home_assistant_password="$(openssl rand -hex 24)"
doorstate_password="$(openssl rand -hex 24)"

printf '%s\n' \
  "HOME_ASSISTANT_MQTT_USERNAME=homeassistant" \
  "HOME_ASSISTANT_MQTT_PASSWORD=${home_assistant_password}" \
  "DOORSTATE_MQTT_USERNAME=doorstate" \
  "DOORSTATE_MQTT_PASSWORD=${doorstate_password}" \
  "DOORSTATE_VERSION=local" \
  "DOORSTATE_ARCH=$(uname -m | sed 's/^arm64$/aarch64/; s/^x86_64$/amd64/')" \
  "TZ=${TZ:-Australia/Perth}" \
  > "${environment_file}"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${deployment_dir}/mosquitto/config:/mosquitto-config" \
  eclipse-mosquitto:2 \
  mosquitto_passwd -b -c /mosquitto-config/passwd homeassistant "${home_assistant_password}"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "${deployment_dir}/mosquitto/config:/mosquitto-config" \
  eclipse-mosquitto:2 \
  mosquitto_passwd -b /mosquitto-config/passwd doorstate "${doorstate_password}"

docker run --rm \
  --entrypoint sh \
  -v "${deployment_dir}/mosquitto/config:/mosquitto-config" \
  -v "${deployment_dir}/mosquitto/data:/mosquitto-data" \
  eclipse-mosquitto:2 \
  -c "chown 1883:1883 /mosquitto-config/passwd && chmod 640 /mosquitto-config/passwd && chown -R 1883:1883 /mosquitto-data && chmod 700 /mosquitto-data"

chmod 600 "${environment_file}"

echo "MQTT credentials created in ${environment_file}."
echo "The file and Mosquitto password database are ignored by Git."
