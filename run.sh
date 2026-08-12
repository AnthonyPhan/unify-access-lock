#!/usr/bin/with-contenv bashio

export CONFIG_PATH="${CONFIG_PATH:-/data/config.json}"
export PORT="${PORT:-8080}"
export SETUP_PORT="${SETUP_PORT:-8080}"
export HOME_ASSISTANT_INGRESS="${HOME_ASSISTANT_INGRESS:-false}"

if [ -n "${SUPERVISOR_TOKEN:-}" ] && bashio::services.available "mqtt"; then
  export HOME_ASSISTANT_INGRESS="true"
  doorstate_mqtt_scheme="mqtt"
  doorstate_mqtt_ssl="$(bashio::services mqtt 'ssl')"
  if [ "${doorstate_mqtt_ssl}" = "true" ]; then
    doorstate_mqtt_scheme="mqtts"
  fi

  export HA_MQTT_URL="${doorstate_mqtt_scheme}://$(bashio::services mqtt 'host'):$(bashio::services mqtt 'port')"
  export HA_MQTT_USERNAME="$(bashio::services mqtt 'username')"
  export HA_MQTT_PASSWORD="$(bashio::services mqtt 'password')"
  export HA_MQTT_SOURCE="supervisor"
fi

cd /opt/doorstate
exec node dist/index.js
