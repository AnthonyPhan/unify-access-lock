# Doorstate for Home Assistant

Doorstate replaces UniFi Access's short native unlock trigger with a cancellable temporary rule. It then relocks when a fresh Door Position Sensor (DPS) transition reports that the door or gate has opened. The configured maximum unlock time remains the fallback.

## Requirements

- Home Assistant OS or Home Assistant Supervised with Apps/Add-ons support.
- The Home Assistant MQTT integration and an MQTT broker such as Mosquitto, if native entities are desired.
- A UniFi Access console reachable from the Home Assistant host.
- A UniFi Access API key with **Locations: View/Edit**, **System Log: View**, and **Webhooks: View/Edit** permissions.
- A working DPS for each monitored door or gate.

Home Assistant Container and Home Assistant Core do not provide Supervisor apps. Use Doorstate as a standalone Node service for those installation types.

## Home Assistant Container installation

On a normal Linux host with Docker Compose, clone the repository and use the bundled standalone stack:

```sh
git clone https://github.com/AnthonyPhan/unify-access-lock.git
cd unify-access-lock/deploy
./setup-mqtt.sh
docker compose up -d --build
```

The stack creates separate random credentials for Home Assistant and Doorstate. It binds Mosquitto only to `127.0.0.1:1883`, publishes Doorstate on port `8080`, and persists Doorstate configuration in a named Docker volume.

In Home Assistant, open **Settings → Devices & services → Add integration → MQTT** and enter:

- Broker: `127.0.0.1`
- Port: `1883`
- Username and password: `HOME_ASSISTANT_MQTT_USERNAME` and `HOME_ASSISTANT_MQTT_PASSWORD` from `deploy/.env`

Leave MQTT discovery enabled. Doorstate uses its separate credentials automatically through Compose. Do not commit `deploy/.env` or `deploy/mosquitto/config/passwd`; both are ignored by Git.

## Local installation

1. Copy or clone this repository to `/addons/doorstate` on the Home Assistant host.
2. Open **Settings → Apps → App store** and reload the store.
3. Open **Local apps**, select **Doorstate**, and install it.
4. Start Doorstate and select **Open Web UI**.

Configuration is stored in the app's persistent `/data/config.json` and is included in Home Assistant backups.

## Configuration

1. Enter the UniFi Access console API URL and API key.
2. Enter a webhook URL using the Home Assistant host's LAN address and Doorstate's exposed port, for example `http://192.168.1.50:8080/webhooks/unifi`.
3. Test the connection and select the doors to monitor.
4. Set the native trigger to match the value configured in UniFi Access. **One second is recommended.**
5. Leave automatic relocking off while testing, then enable it and select **Save & apply**.
6. Enable **Publish Home Assistant entities**. The app automatically uses the Supervisor MQTT service; manual broker fields are only needed outside Home Assistant or to override it.

Do not give UniFi the Home Assistant ingress URL. Ingress is authenticated and intended for the browser; the console must deliver its signed webhook directly to port 8080. If you change the host-side port in the app's Network settings, use that port in the webhook URL.

## Native Home Assistant entities

Doorstate uses MQTT discovery to create a **Doorstate** controller device and one device per UniFi door.

The controller device provides:

- Runtime and UniFi API connectivity diagnostics.
- Last webhook timestamp.
- Automatic relocking switch.
- Maximum unlock time and additional lock delay numbers.

Each door provides:

- Open/closed DPS binary sensor.
- Relay and relock-state sensors.
- Last event diagnostic sensor.
- A **Lock now** button.
- An optional lock entity that can lock and unlock the door.

Remote unlock is deliberately absent by default. Enable **Allow unlock from Home Assistant** only after securing Home Assistant accounts, MQTT credentials, dashboards and remote access. MQTT commands are serialized and duplicate physical commands received within one second are ignored.

MQTT is not part of the automatic relock path. If the broker, MQTT integration or Home Assistant Core is unavailable, the entities become unavailable but Doorstate continues processing signed UniFi webhooks and operating the lock directly. Invalid MQTT settings likewise do not prevent the UniFi controller from starting.

If entities do not appear, confirm that MQTT is configured under **Settings → Devices & services**, MQTT discovery is enabled, and the Doorstate UI reports **Home Assistant connected**.

## Security

Home Assistant authenticates access through ingress. Direct access to the exposed port retains Doorstate's administrator authentication. Webhook requests are accepted only when their UniFi signature and timestamp are valid.

The API key and generated signing data are stored with the app's persistent configuration. Do not share Home Assistant app backups with untrusted parties.

Supervisor-provided MQTT credentials are used from the runtime environment and are not copied into Doorstate's persisted configuration. Manually supplied MQTT passwords are stored alongside the UniFi configuration and are never returned to the browser or included in discovery payloads.
