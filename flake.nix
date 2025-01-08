{ description = "Tiled, scrollable window management for GNOME Shell";

  inputs."nixpkgs".url = github:NixOS/nixpkgs;

  outputs = { self, nixpkgs, flake-utils, ... }:
  flake-utils.lib.eachDefaultSystem
    (system:
    let pkgs = import nixpkgs { inherit system; };
    in
    { packages.default = pkgs.callPackage ./default.nix {};
      packages.vm = let hostConfig = self.nixosConfigurations.testbox.config;
                        localConfig = hostConfig // {
                          virtualisation = hostConfig.virtualisation // {
                            host.pkgs = pkgs;   # Use host system's Qemu
                          };
                        };
                     in localConfig.system.build.vm;
    }) // {
      nixosConfigurations."testbox" =
        let system = "x86_64-linux";
        in nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            ./vm.nix
            { nixpkgs.overlays = [
                (s: super: { paperwm = self.packages.${system}.default; })
              ];
            }
          ];
        };
    };
}
