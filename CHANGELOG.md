# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-22

### Added

- `container` / `containerWorkdir` profile fields: on hosts whose toolchain lives in a container (a robot ROS gateway, for example), helper commands and capability probes now run through `docker exec -w <workdir> <container> bash -lc <script>` instead of on the host. Without this, `/ssh-remote on <robot>` routed ROS tools to a host that has no ROS at all.
- `ssh_exec` takes an optional `container` argument and defaults to the host, so `docker ps` and `systemctl` stay one call away while `ros2 node list` can target the gateway container.
- With a container, local paths map to `containerWorkdir` rather than the host checkout, and an unmappable path still fails closed.
- `test/version.test.ts`: `TOOL_VERSION` must equal `package.json` version, so the response envelope cannot claim a version the package is not.

### Fixed

- The capability probe now runs in the same environment as the commands (container and prelude included). It previously measured the host shell, which reported "ros2 CLI is missing" for a robot whose ROS only exists inside a container.

## [0.1.1] - 2026-10-22

### Fixed

- `0.1.0`은 npm 웹 2FA 흐름을 거쳐 공개되었지만 **provenance가 없습니다**(staged로 만들어진 뒤 같은 버전으로 CI 재배포가 `E409 Cannot publish over previously staged version`으로 막혔습니다). 코드 변경 없이 버전만 올린 `0.1.1`이 **CI(OIDC)에서 provenance와 함께 배포된 첫 버전**이며 `latest`입니다. 새로 설치할 때는 `0.1.1` 이상을 쓰세요.

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
