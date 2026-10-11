{
  description = "Tiled, scrollable window management for GNOME Shell";

  inputs."nixpkgs".url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs."nixpkgs-gnome-next".url = "github:theCapypara/nixpkgs/gnome51";

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-gnome-next,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        hostPkgs = import nixpkgs { inherit system; };
        # Build QEMU for the host system to avoid double emulation.
        mkVm =
          hostConfig:
          let
            localConfig = hostConfig.extendModules {
              modules = [
                (
                  { modulesPath, ... }:
                  {
                    imports = [ "${modulesPath}/virtualisation/qemu-vm.nix" ];
                    virtualisation.host.pkgs = hostPkgs;
                  }
                )
              ];
            };
          in
          localConfig.config.system.build.vm;
      in
      {
        packages.default = hostPkgs.buildNpmPackage {
          pname = "gnome-shell-extension-albumwm";
          version = "unstable";
          src = ./.;

          npmDepsHash = "sha256-s9rys6lcAsljw5PttSSGWtTpS0bRnPcdnRJqCNdjvm8=";

          nativeBuildInputs = with hostPkgs; [
            glib
            # https://gitlab.gnome.org/GNOME/blueprint-compiler/-/merge_requests/312
            (blueprint-compiler.overrideAttrs (old: {
              patches = (old.patches or [ ]) ++ [
                (fetchpatch {
                  url = "https://gitlab.gnome.org/poli0iq/blueprint-compiler/-/commit/908cefe67d258b847ba0e8d406101d22b95a8a28.patch";
                  hash = "sha256-MBDDO0vEKbHdTgcnhdHKpE9NfRZrvQFaC/wOLoR9YMA=";
                })
              ];
            }))
          ];

          # Default buildPhase already includes "npm run build"
          postBuild = ''
            glib-compile-schemas --strict dist/schemas
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/gnome-shell/extensions
            cp -r dist $out/share/gnome-shell/extensions/albumwm@0iq.dev
            runHook postInstall
          '';

          passthru = {
            extensionPortalSlug = "albumwm";
            extensionUuid = "albumwm@0iq.dev";
          };
        };

        devShells.default = hostPkgs.mkShell {
          inputsFrom = [ self.packages.${system}.default ];

          nativeBuildInputs = with hostPkgs; [
            zip
          ];
        };

        packages.vm = mkVm self.nixosConfigurations.testbox;
        packages.vm-gnome-next = mkVm self.nixosConfigurations.testbox-gnome-next;
      }
    )
    // {
      nixosConfigurations =
        builtins.mapAttrs
          (
            name: pkgsInput:
            let
              system = "x86_64-linux";
            in
            pkgsInput.lib.nixosSystem {
              inherit system;
              modules = [
                (
                  { pkgs, lib, ... }:
                  {
                    networking.hostName = lib.mkIf (name != "testbox") name;

                    # Make AlbumWM available in system environment
                    environment.systemPackages = with pkgs; [
                      albumwm
                      (lib.getBin libinput)
                    ];

                    # Set graphical session to auto-login GNOME
                    services.xserver = {
                      enable = true;
                      displayManager.autoLogin = {
                        enable = true;
                        user = "user";
                      };
                      displayManager.gdm.enable = true;
                      desktopManager.gnome.enable = true;
                    };

                    # Set dconf to enable AlbumWM out of the box
                    programs.dconf = {
                      enable = true;
                      profiles."user".databases = [
                        {
                          settings = {
                            "org/gnome/shell" = {
                              enabled-extensions = [ "albumwm@0iq.dev" ];
                              disable-user-extensions = false;
                              disable-extension-version-validation = name == "testbox-gnome-next";
                            };
                          };
                          # NOTE: You can add more dconf settings to test with here!
                        }
                      ];
                    };

                    # Remove unnecessary dependencies
                    # NOTE: This drops many GTK4 apps, re-enable if needed for testing.
                    services.gnome.core-utilities.enable = false;

                    # Set default user
                    users.users."user" = {
                      isNormalUser = true;
                      createHome = true;
                      home = "/home";
                      description = "AlbumWM test user";
                      extraGroups = [ "wheel" ];
                      password = "albumwm";
                    };

                    # No-password sudo
                    security.sudo = {
                      enable = true;
                      extraConfig = "%wheel ALL=(ALL) NOPASSWD: ALL";
                    };
                  }
                )
                {
                  nixpkgs.overlays = [
                    # Introduce AlbumWM into our extensions
                    (s: super: { albumwm = self.packages.${system}.default; })
                  ];
                }
              ];
            }
          )
          {
            testbox = nixpkgs;
            testbox-gnome-next = nixpkgs-gnome-next;
          };
    };
}
