{ pkgs ? import <nixpkgs> {} }:

let
  # SCB published from sdlcworks/public-releases via .github/workflows/cli-release.yml.
  # Tag form is `components-build/<sem>`; the published asset is named after
  # the build label declared in sdlc.toml (`[components-build.build.default]`),
  # so the asset is `components-build-default`. The local binary keeps its
  # `sdlc-components-build` name for $PATH compatibility.
  version = "0.0.13";

  repo = "sdlcworks/public-releases";
  releaseTag = "components-build/${version}";
  assetName = "components-build-default";
  binaryName = "sdlc-components-build";

  releaseUrl = "https://github.com/${repo}/releases/download/${releaseTag}/${assetName}";

  sdlc-components-build = pkgs.runCommand "${binaryName}-${version}" {} ''
    mkdir -p $out/bin
    install -m755 ${builtins.fetchurl { url = releaseUrl; }} $out/bin/${binaryName}
  '';
in

pkgs.mkShell {
  buildInputs = [
    pkgs.bun
    pkgs.nodejs_22
    sdlc-components-build
  ];
}
