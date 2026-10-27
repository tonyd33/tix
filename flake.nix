{
  description = "tix - Markdown tickets with YAML frontmatter";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems = f: nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.writeShellScriptBin "tix" ''exec ${pkgs.bun}/bin/bun ${./tix.ts} "$@"'';
      });
    };
}
