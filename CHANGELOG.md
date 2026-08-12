# Changelog

## 0.2.0

- Add a TypeScript MQTT bridge with Home Assistant MQTT discovery.
- Publish controller and per-door native entities for DPS, relay, automation state, diagnostics, configuration and commands.
- Automatically use the Home Assistant Supervisor MQTT service with standalone manual-broker fallback.
- Keep remote unlock opt-in and serialize/deduplicate physical MQTT commands.
- Keep MQTT failures isolated from the UniFi relock controller.
- Add live MQTT status and commissioning options to the ingress UI.

## 0.1.0

- Package the existing Doorstate service as a local Home Assistant app/add-on.
- Add Home Assistant ingress support without exposing the UI through an unauthenticated bypass.
- Persist configuration in the Home Assistant app data volume.
- Retain the signed webhook endpoint on the configurable host port.
