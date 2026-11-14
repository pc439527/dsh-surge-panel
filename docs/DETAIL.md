# Surge System Monitor

![Surge system monitor](preview.svg)

A DSH-native plugin adapted from the original `surge-lan-console`. All data comes from the local / LAN Surge HTTP API (the Host reads the local `X-Key`; manually entered keys are submitted to the Host for testing or saving, and stored keys are never returned to the browser). No metrics are faked.

## Three tabs

- **Overview**: download/upload speed, session traffic, uptime, active connections, traffic trend, LAN device fleet, network environment, node traffic and recent events.
- **Device management**: CRUD for multiple Surge instances (connections), set-active, connectivity test, and fleet totals (online devices, active requests, total down/up). The first entry is always "Local Surge", discovered from the local Surge profile by the Host.
- **Settings**: appearance (system / light / dark, scoped to this panel), poll interval, trend sample points, device/event display limits, pause polling, current connection, API diagnostics (per-endpoint status / latency / response shape), about and reset to defaults.

## Features recovered from the reference product

| Reference product | DSH-native equivalent here |
| --- | --- |
| Connections page (multi-instance CRUD / switch / test) | "Device management" tab + Host-private storage |
| Fleet page (cross-instance online status + throughput totals) | "Device management" fleet strip + per-connection status badges |
| Settings page (appearance / current connection / about) | "Settings" tab, preferences in browser localStorage |
| API Diagnostics (per-endpoint checks) | "Settings" → API diagnostics table |

Preferences and connections are stored separately: preferences in browser `localStorage`; connection metadata and API keys in `~/.dsh/surge-panel-connections.json` (plain JSON, mode 600). Connection lists return a `hasKey` flag, connection metadata and CA certificates, without stored keys. Overview and diagnostics target the selected instance; Fleet always includes all configured connections and Local Surge.

## Reliability updates in 1.1.1

- **Connection and sample isolation**: changing a connection or its configuration clears trend samples. Late responses are cancelled or ignored. The Host checks configuration revisions during collection so data cannot be relabelled as another instance.
- **Bounded requests**: Surge requests have a total deadline and settle on aborted, errored, prematurely closed or oversized responses (16 MiB limit). Browser requests time out and are cancelled on unmount. Request bodies must be JSON objects, with a 64 KiB limit and a 10-second deadline.
- **Atomic persistence**: connections are written to an exclusive mode-600 temporary file and renamed before committing the in-memory state. Write failures are surfaced and preserve the previous connection and key. Corrupt storage is never silently overwritten.
- **Verified HTTPS**: certificate chains and hostnames are verified. HTTPS connections accept an optional PEM CA certificate (16 KiB limit) for private or self-signed certificates. For an untrusted auto-discovered local HTTPS endpoint, add a manual HTTPS connection with the CA. Enter only a domain or IP in the host field and set the port separately; IPv6 is supported.
- **On-demand polling and shared caches**: automatic sampling runs only while the panel is mounted, the page is visible and polling is unpaused. The next poll starts after the previous request settles. The Host coalesces concurrent snapshots and endpoint requests. Successful policies, modules, rules and profile results are cached for 60 seconds; other successes and all failures for 1 second. Local discovery is cached for 30 seconds. Fleet refreshes on tab entry or manually, with at most four instances probed concurrently.
- **Honest availability**: optional endpoint failures show unavailable data, or the last successful result and its timestamp, instead of zero or an empty list. Incomplete Fleet request totals show `—`; throughput totals include only instances with a successful current response. Connection loading, testing, persistence and diagnostics errors are surfaced in the panel.

## Development checks

Run `npm run check` for Host and Client syntax checks and `npm test` for regression tests. Tests use isolated storage and transport doubles, do not read real keys or contact Surge, and do not emulate React or browser layout. Real TLS handshakes, Surge version compatibility and visual layout still require validation in the actual environment.

## Display fixes

- **Traffic x-axis**: instead of one label per sample (previously up to 48 cramped `13:37` spans overflowing the container), at most six evenly-spaced ticks (`HH:MM:SS`, with seconds) are taken from the real label buffer, with `overflow:hidden`, `white-space:nowrap` and even ticks hidden on narrow screens.
- **Recent events**: identical (tone + text) events are merged into one row with a `×N` badge, single-line ellipsis with full text on hover, time aligned right — no more fragmented two-line flood of the same error.

## Notes

The reference product's "lock console", "notifications / background automation", "MitM / Rewrite / feature toggles", "encrypted Vault" and "demo mode (faked data)" depend on a separate Node Core, SQLite, system notifications and background task layer. This plugin is a read-only DSH-native panel: it does not embed those backends and never fakes data. All other read-only monitoring features are available.
