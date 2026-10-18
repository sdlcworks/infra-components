{ pkgs ? import (builtins.fetchTarball {
  url = "https://github.com/NixOS/nixpkgs/archive/549bd84d6279f9852cae6225e372cc67fb91a4c1.tar.gz";
  sha256 = "sha256-hGdgeU2Nk87RAuZyYjyDjFL6LK7dAZN5RE9+hrDTkDU=";
}) {} }:

pkgs.mkShell {
  buildInputs = [
    pkgs.bun
    pkgs.nodejs_22
  ];
}
