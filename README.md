# UniFi Access DPS-aware relock

This TypeScript-enabled Node.js service keeps a UniFi Access door unlocked until it is opened, then relocks it immediately. It also shows live door position sensor (DPS) state, publishes native Home Assistant devices through MQTT discovery, and provides explicitly confirmed API command tests.

It can run either as a standalone Node service or as a local Home Assistant app/add-on. The Home Assistant package uses the same controller and configuration UI rather than maintaining a second implementation.

It uses the official local UniFi Access API and signed webhooks. Configure the hub's native Lock Trigger Duration to **1 second**. Doorstate replaces that short native trigger with a cancellable custom unlock rule; do not use 0.1 seconds because it leaves too little time for webhook delivery and the takeover API call.

## Behavior

1. UniFi performs an ordinary unlock from a reader, REX input, mobile app, remote admin action, or other supported source.
2. Doorstate receives `access.door.unlock`, confirms no protected schedule or temporary rule is active, and immediately applies a cancellable `custom` unlock rule.
3. When DPS reports `open`, Doorstate waits until the configured native-trigger safety window has expired, then sends `lock_now`.
4. Doorstate verifies the relay state and retries if UniFi accepted the command while the native trigger was still active.
5. If the door never opens, the configured maximum timeout sends `lock_now`. UniFi's custom rule—rounded up to whole minutes—remains an independent fallback if the Pi or network fails.

Unlock schedules, leave-unlocked rules, emergency evacuation, and lockdown remain protected from ordinary DPS automation.

## Requirements

- Node.js 18.17 or newer.
- A current UniFi Access release. The official docs list Access 1.24.6+ for door locking rules and 2.2.10+ for webhooks.
- A wired and correctly configured DPS for every monitored door.
- A static IP or resolvable hostname for the Pi that the UniFi console can reach.
- An Access API token with these permission keys:
  - `view:space`
  - `edit:space`
  - `view:webhook`
  - `edit:webhook`

Create the token in **UniFi Access -> Settings -> General -> Advanced -> API Token**. The local API normally uses `https://<console-ip>:12445`.

## Run and configure

No `.env` file is required for interactive setup:

```sh
npm test
npm start
```

Open `http://<raspberry-pi-ip>:8080` and complete the four sections:

1. Enter the console URL and API token.
2. Enter a webhook URL using the Pi's static LAN address, such as `http://192.168.1.50:8080/webhooks/unifi`.
3. Select **Test connection & find doors**, then choose the doors to monitor.
4. Set the native trigger to match UniFi, leave automatic relocking off while commissioning, and create an administrator password under **Advanced settings**.

After the webhook and handoff tests pass, enable **Automatic DPS relocking** and select **Save & apply**.

Select **Save & apply**. Connection, timeout, open-to-lock delay, webhook and door-selection changes take effect without restarting. Changing the local service port is saved but requires a restart because the browser is connected to the old listener.

The **Doors** panel shows each current DPS position. After the initial position is read from UniFi, the badge changes between **Open** and **Closed** as signed DPS webhooks arrive; the browser keeps a live authenticated status connection open, so no refresh is needed.

### Test webhook delivery

After the service status is ready and the configuration has been saved, select **Test webhook** in the Event callback section. Doorstate first confirms that UniFi has the expected subscription and callback URL, then listens for a signed event for 60 seconds. Unlock a door or move its DPS during that window. A successful result shows the event type and door received directly from the UniFi console.

This is an end-to-end delivery test, not a simulated local callback. Leave automatic DPS relocking off while commissioning if you only want to observe delivery.

### Test door commands directly

The **Relock behavior** section includes a physical door-command test. Doorstate reads the current rule and relay state, sends the selected API command, waits briefly and reads both again.

The `handoff_1s` command tests the original takeover design without the old 60-second trigger masking the result:

1. In UniFi Access, set the lock's native Trigger Duration to exactly 1 second.
2. Start with the door locked and run `handoff_1s`.
3. Doorstate sends `unlock`, waits 250 ms, applies a one-minute `custom` unlock, waits until two seconds after the initial unlock, and sends `lock_now`.
4. The result displays the relay and rule before the test, after the native trigger has expired, and after `lock_now`.

This is an explicitly confirmed manual test and remains available while automatic relocking is off. If `lock_now` changes the final relay state to `lock`, the short-trigger handoff design is viable. The one-minute custom rule remains the fallback if it does not.

To verify whether a cancellable custom rule can replace the hub's native trigger:

1. Start with the door locked and send `custom`. This applies a one-minute timed unlock rule, retaining an automatic fallback.
2. Confirm the latch releases and the result changes the relay from `lock` to `unlock`, with the rule changing to `custom`.
3. Select `lock_now` and send it before the custom rule expires.
4. If the relay changes back to `lock`, the custom-rule design is viable on this hub.

The native `unlock`, `reset`, and `lock_early` commands remain available for comparison. UniFi defines `reset` for temporary unlock schedules and `lock_early` for ending an active unlock schedule early.

The result distinguishes three cases:

- A rejected API request identifies the endpoint, error code and required `edit:space` permission.
- An accepted command that changes `door_lock_relay_status` confirms that command operated the hub.
- An accepted command that leaves the relay triggered confirms the console accepted the API request but the active UniFi rule or hub behavior retained control. The before/after rule types are displayed for diagnosis.

This button intentionally bypasses monitor-only mode and asks for confirmation before operating the selected door.

The web app never returns stored API tokens, webhook secrets, or password hashes to the browser. Blank secret fields preserve the existing value. Configuration is stored as an atomic, mode-`0600` JSON file in `./data/config.json` by default. Set `CONFIG_PATH` to move it.

For headless or bootstrap configuration, copy [.env.example](.env.example) to `.env`. Persisted web settings take precedence over matching `.env` values.

### TLS and LAN access

The stock UniFi Access API certificate is self-signed. Prefer installing a trusted certificate. Otherwise, turn off **Verify console certificate** only on a trusted, isolated management LAN.

The web app is initially open so first-time setup is possible. Set the administrator password during the first visit before exposing port 8080 to other LAN clients. Configuration APIs then require HTTP Basic credentials; webhook delivery and the minimal health endpoint remain separate. Basic credentials are only transport-encrypted when the web app is served through HTTPS, so use a trusted management LAN or put the service behind an HTTPS reverse proxy.

Health is available at:

```sh
curl http://127.0.0.1:8080/healthz
```

## Home Assistant app/add-on

Home Assistant OS and Home Assistant Supervised users can run this repository as a local app:

1. Copy or clone the repository to `/addons/doorstate` on the Home Assistant host.
2. Reload **Settings → Apps → App store**.
3. Install **Doorstate** from **Local apps**, start it, and select **Open Web UI**.
4. Configure the UniFi webhook as `http://<home-assistant-host>:8080/webhooks/unifi`; do not use the authenticated ingress URL as the webhook destination.

The app requests Home Assistant's MQTT service and automatically receives its broker credentials from Supervisor. Once **Publish Home Assistant entities** is enabled, Doorstate creates native devices containing DPS, relay, relock-state, relock-deadline, diagnostic, lock-now and configuration entities. Remote unlock remains disabled until separately opted in; when enabled it is exposed through Home Assistant's native lock slider. Container deployments can load `deploy/home-assistant/front-gate-lock-countdown.js` to show the active relock deadline as a progress ring on that slider.

MQTT mirrors state and carries user commands only. The safety-critical UniFi webhook → Doorstate controller → UniFi API path does not pass through Home Assistant or MQTT, so broker or Core restarts do not interrupt automatic relocking.

The UI is available through Home Assistant ingress, while the mapped port remains available for signed webhook delivery from the UniFi console. Configuration is persisted in the Home Assistant app data volume. See [DOCS.md](DOCS.md) for complete installation, entity and security details.

## Home Assistant Container with Docker Compose

For Home Assistant Container on a general-purpose Linux host, the source-controlled deployment in `deploy/compose.yaml` runs Doorstate and a private Mosquitto broker alongside Home Assistant. Mosquitto is bound to host loopback only; Home Assistant reaches it at `127.0.0.1:1883`, while Doorstate reaches it over the private Compose network.

```sh
git clone https://github.com/AnthonyPhan/unify-access-lock.git
cd unify-access-lock/deploy
./setup-mqtt.sh
docker compose up -d --build
```

Then add the MQTT integration in Home Assistant using broker `127.0.0.1`, port `1883`, and the `HOME_ASSISTANT_MQTT_*` credentials in `deploy/.env`. MQTT discovery is enabled by default. Open Doorstate at `http://<host>:8080`, complete UniFi setup, enable **Publish Home Assistant entities**, and save.

The generated `.env`, Mosquitto password database, broker data, and Doorstate runtime configuration are excluded from Git. The plaintext `.env` is owner-only; the hashed password database grants read access only to Mosquitto's container group. The public repository contains only deployment definitions and examples.

## Raspberry Pi systemd install

Copy this directory to `/opt/unifi-access-lock`, create a dedicated system user, and install the included unit:

```sh
sudo useradd --system --home /opt/unifi-access-lock --shell /usr/sbin/nologin unifi-access-lock
sudo chown -R unifi-access-lock:unifi-access-lock /opt/unifi-access-lock
sudo cp deploy/unifi-access-lock.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now unifi-access-lock
sudo journalctl -u unifi-access-lock -f
```

Open `http://<raspberry-pi-ip>:8080`. The systemd unit creates `/var/lib/unifi-access-lock` as a private writable state directory and saves configuration there. `/etc/unifi-access-lock.env` remains an optional bootstrap override; the unit starts normally when that file does not exist.

Allow inbound TCP 8080 from your administrator network and from the UniFi console through any Pi firewall or VLAN ACL. The process does not need root privileges.

## Safety notes

- Set UniFi's native Lock Trigger Duration to 1 second, not 0.1 seconds. It safely relocks quickly if Doorstate cannot take over an unlock.
- Commission with automatic DPS relocking off, run the webhook and `handoff_1s` tests, then test the exact hub, lock hardware, REX wiring, schedules, emergency modes and fire/life-safety behavior before enabling automatic mode.
- Egress must not depend on this Node process.
- The service fails conservatively: if it cannot read the current lock rule or apply the custom takeover, it leaves the short native UniFi trigger in control rather than risking cancellation of a protected state.

Official references: [Getting Started with the Official UniFi API](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API) and the [UniFi Access API reference](https://assets.identity.ui.com/unifi-access/api_reference.pdf).
