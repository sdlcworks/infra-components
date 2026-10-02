# The nixpkgs channel is pinned here, not taken from the runner's NIX_PATH:
# the runner's channel (nixos-24.05) ships bun 1.1.8, which ignores Bun.build
# dependency externalization and bakes build-machine absolute paths into the
# bundle. sdlc-components-build requires bun >= 1.1.21; nixos-25.05 ships 1.2.13.
{ pkgs ? import (fetchTarball "https://github.com/NixOS/nixpkgs/archive/nixos-25.05.tar.gz") {} }:

# NOTE: sdlc-components-build is intentionally NOT provided here. The CI
# runner installs it at the version pinned by the branch op_config; a copy
# in this shell would shadow that pin (nix-shell prepends its bin paths to
# PATH) and silently run a stale toolchain. Local devs: install SCB onto
# your own PATH.

pkgs.mkShell {
  buildInputs = [
    pkgs.bun
    pkgs.nodejs_22
  ];
}
