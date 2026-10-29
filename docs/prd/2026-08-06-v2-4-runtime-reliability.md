---
status: done
---

## Problem statement <!-- prd:problem -->

The current `v2.3.1.0` already has a usable KernelSU/APatch WebUI, configuration management, a Peer list, and on-demand diagnostics, but four classes of observable problems remain: a module upgrade moves `config.env` into a backup and then generates a default config; the single-packet Peer test misreads the first-packet DERP path as the stable path; the fixed ten-second status refresh and full Peer DOM rebuilds still cause lag; and releases depend on Tag pushes, but under the current maintainer credentials a Tag push does not reliably trigger GitHub Actions, so Releases have to be created by hand.

The runtime also lacks optional crash recovery, a log size limit, a central health check, a redacted diagnostic report, and config copy/import. The WebUI's shell bridge, runtime protocol, state management, and DOM logic are all concentrated in `app.ts`, which makes the key orchestration behavior hard to test through a stable interface.

## Desired outcome <!-- prd:outcome -->

Release `v2.4.0.0` with the following observable results:

1. An overwrite install preserves the existing config and node state; new config fields are filled with defaults, and a recoverable backup is kept on failure.
2. The Peer card clearly distinguishes the "status path (recent activity)" from the "this probe" result; a manual probe sends five packets and shows the path progression, the last path observed in this probe, latency, and time, and no longer treats the first-packet DERP path as the stable path.
3. The WebUI uses adaptive refresh; while hidden, during diagnostics, and when nothing has changed, it does no pointless refreshes or Peer rebuilds, and old data is kept with a "stale" marker.
4. The WebUI provides a manual health check, a structured Netcheck summary, the raw output, and one-click copy of a redacted report.
5. Users can opt in to the watchdog and configure a log size limit; a manual stop is not restarted by the watchdog, and crash restarts use backoff and are counted.
6. Users can copy the current runtime config, and can paste JSON into the WebUI to preview it and import it through the existing save flow; node keys and state files are never part of the exported content.
7. The shell bridge and runtime commands are consolidated into a testable `RuntimeClient` interface, so UI callers no longer need to understand markers, KernelSU spawn, fallback, timeout, and stderr details.
8. The manual release entry point in GitHub Actions can complete version validation, build, tests, Tag/Release, SHA256SUMS, and a post-release download check; if the Tag does not match the repository version it fails, rather than modifying source in CI on the fly.

## User stories and acceptance criteria

1. As an existing module user, after upgrading my Headscale URL, hostname, startup arguments, and WebUI settings are unchanged.
2. As a troubleshooting user, I can understand how a Peer's recent-activity status path differs from the five-packet probe path, and I can see when the result was produced.
3. As a mobile user with many Peers, scrolling and tapping stay responsive, and no status polling happens while the page is hidden.
4. As a maintainer, I can copy a diagnostic report that contains no node private keys and use it to judge the state of the daemon, Backend, TUN, SELinux, logs, and network probes.
5. As a maintainer, I can produce a verifiable official release through a single entry point whose results can be read back.

## Implementation decisions <!-- prd:implementation -->

- The version is updated to `v2.4.0.0`, `versionCode=02040000`. `tailscale-android-cli v1.98.8-android` stays pinned; the Android kernel is not upgraded, and a kernel upgrade is not an interactive decision for this task.
- No PR is created against the upstream repository; only `NightWatcher314/magisk-tailscaled` is maintained and released.
- On an overwrite install, `customize.sh` copies `config.env` into the versioned backup while keeping the original file; binaries, scripts, and runtime logs are still replaced under the existing policy. Missing new fields are filled from the `settings.sh` defaults. After install it verifies that the config is readable; on failure it keeps the backup and aborts, and must not silently reset.
- New config keys are limited to the watchdog switch, the log size limit, and necessary internal runtime state; they continue to be managed through the `tailscaled.config` allowlist, atomic writes, and `0600` permissions.
- The watchdog is off by default. When enabled, it only watches a daemon that was not stopped on purpose; it uses a manual-stop marker, limited retries, exponential backoff, and a visible counter. It stops when the module is disabled or the config turns it off.
- Log rotation is handled in one runtime implementation covering both the daemon and operation logs; it uses a size threshold and a limited number of history files, adds no separate log service, and rotates continuously through a lightweight writer that shares the command's lifecycle.
- Peer probing stays manual, using `tailscale ping -c 5 --until-direct=false --timeout 2s`, and never probes continuously in the background. It parses every `pong` line and outputs the path sequence, the last path of this probe, the average latency, and a timestamp. When the status path changes, the older probe is marked stale.
- The health check is manual. The fast status refresh does not automatically run `netcheck`, SELinux log scans, or multi-packet pings. The health check returns structured JSON; Netcheck is run separately on demand with `tailscale netcheck --format=json`, with stderr warnings kept apart from the JSON stdout.
- Config export contains only the fields already managed by `tailscaled.config get`; import accepts only the same allowlisted fields, first fills in the UI and marks it unsaved, and then validation and persistence are done by the existing `set-many` save path.
- A new deep WebUI module, `RuntimeClient`, whose interface covers at least snapshot, log, saveConfig, action, peerProbe, netcheck, and health. KernelSU `spawn`, legacy `exec`, the Android fallback, shell quoting, the exit marker, and timeouts stay internal to the implementation.
- Adaptive refresh uses a single scheduler: it stops while the page is hidden; it refreshes immediately when the page returns or a user action completes; it slows down when idle; and it pauses during diagnostics. Peers are keyed by ID, then status map key, then first Tailscale IP; the card DOM is not replaced when the display ViewModel is unchanged.
- The release workflow does not edit version files on the fly in the Tag job. The manual entry point treats the committed `module.prop` and update JSON as the source of truth, creates or verifies the matching Tag, uploads the two ZIPs for the current version plus `SHA256SUMS`, then downloads and verifies them again.

## Testing decisions <!-- prd:testing -->

- Add an upgrade install test covering config preservation, new-field defaults, backup existence, and that an invalid config fails without resetting.
- Extend the shell integration tests to cover a watchdog manual stop, crash backoff, log rotation, health JSON, five-packet peer-test, JSON Netcheck, and rejection of argument injection.
- WebUI unit tests cover multi-packet path sequences, the DERP to Peer Relay/direct progression, latency parsing, staleness detection, the config-import allowlist, and structured Netcheck.
- `RuntimeClient` is tested through a mocked KernelSU spawn, legacy exec, and Android fallback for success, non-zero exit, stderr, timeout, and concurrent refresh.
- Run TypeScript typecheck, ESLint, Node tests, shell integration, shell syntax, npm audit, the Parcel build, and ZIP content and SHA256 checks.
- Use a real browser with a KernelSU bridge mock to check the mobile viewport: initial state, Peer probe, health check, report copy, config import, hidden/restored refresh, and no console errors.
- After release, read back main, the Tag, the Release, the update JSON, and the asset digests through the GitHub API, and re-download and verify both ZIPs.

## Assumptions and open questions

- The watchdog is off by default, to avoid changing battery life and failure behavior without the user opting in.
- The default log size limit uses a conservative value, chosen during implementation based on existing log volume; the WebUI may adjust it but must constrain it to a reasonable range.
- An overwrite upgrade on KernelSU Next was verified on a real device with `v2.4.0.3` on 2026-08-07; CI pins the official BusyBox from KernelSU Next v3.2.0 and runs the shell regression under `ASH_STANDALONE=1`.
- Real-device coverage for Magisk and APatch is still unverified; an executable real-device regression checklist is kept and this coverage gap is stated explicitly.

## Risks and dependencies

- The human-readable output of `tailscale ping` may change with the Android CLI version; parsing must keep unknown paths and the raw output rather than fail or misreport.
- Android BusyBox/Toybox command differences may affect the watchdog, log size, and timeout implementations; scripts may only use commands the module already depends on and that are covered by tests.
- `config.env` is a shell file; upgrade verification must not execute untrusted new content or write secrets into the diagnostic report.
- If the watchdog misidentifies a manual stop, it will cause a restart loop, so the manual-stop marker and backoff tests are release blockers.
