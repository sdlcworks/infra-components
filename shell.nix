{ pkgs ? import <nixpkgs> {} }:

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
