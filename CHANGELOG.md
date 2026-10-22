# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-22

### Added

- `.github/workflows/ci.yml`: Node 20/22/24 matrix running `npm run check`, plus a separate job for the two tests that carry this package's reason to exist (the remote-mutation gate and the `pi-helper-core` seam).
- `.github/workflows/publish.yml`: tag-triggered release that verifies the tag matches `package.json`, runs the full gate, and publishes with npm Trusted Publishing and provenance. The first publish has to be manual, because a trusted publisher can only be configured on a package that already exists.
- `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`: contribution rules, the threat model around remote execution, and the development contract an agent must keep.
- README: support matrix, the `0.y.z` instability notice, and the release procedure including the first-publish bootstrap.
- `src/ssh/transport.ts`: a `CommandTransport` for `pi-helper-core`, so registering it redirects every `pi-ros-helper`, `pi-python-helper`, and `pi-rust-helper` subprocess to a remote host without touching a call site. Connections are multiplexed with `ControlMaster=auto` and `ControlPersist=600`; `BatchMode=yes` turns an interactive password or host-key prompt into an immediate failure instead of a hung tool call.
- `src/ssh/command.ts` + `src/ssh/quote.ts`: remote commands are assembled as `bash -lc '<script>'` with every path and argument quoted for POSIX `sh`, and the wrapped command is `exec`'d so terminating the client does not leave the real process running remotely.
- `src/ssh/profile.ts`: `ssh_config` parsing that copies ssh's own resolution rule (first obtained value wins, later blocks only fill gaps), plus profile validation that rejects a host name starting with `-`, a non-absolute workspace, and a missing `remoteWorkspace` instead of guessing one.
- `src/ssh/config.ts`: a helper config file (`~/.pi/agent/ssh-helper.json`) that carries only what ssh has no concept of — `remoteWorkspace`, `prelude`, `allowMutating`. Unknown keys are rejected, because a silently ignored typo surfaces later as a build in the wrong directory.
- `src/ssh/capability.ts`: a POSIX-only probe (`printf` + `command -v`) that works on the oldest host in a fleet and reports missing tooling as a stated fact rather than as a mystery failure.
- `ssh_host_status`, `ssh_detect_capabilities`, `ssh_exec` tools, and the `/ssh-remote on|off|status|hosts` command.
- `src/session.ts`: activation state, installed only by a user command. A model that could silently redirect every helper tool to another machine has no way to notice it aimed at the wrong one.
- Remote mutation requires `allowMutating: true` for the host **and** `allowMutating: true` in the call; otherwise `ssh_exec` refuses with `SSH_MUTATION_NOT_ALLOWED`.
