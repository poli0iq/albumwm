{
  description = "Tiled, scrollable window management for GNOME Shell";

  inputs."nixpkgs".url = "github:NixOS/nixpkgs";
  inputs."nixpkgs-gnome".url = "github:vitorpavani/nixpkgs/gnome-50-bump";

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-gnome,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        hostPkgs = import nixpkgs { inherit system; };
      in
      {
        packages.default = hostPkgs.stdenv.mkDerivation {
          pname = "gnome-shell-extension-albumwm";
          version = "unstable";
          src = ./.;

          makeFlags = [
            "SOURCE=$(src)"
            "EXT_DIR=$(out)/share/gnome-shell/extensions"
          ];

          nativeBuildInputs = [ hostPkgs.glib ];

          passthru = {
            extensionPortalSlug = "albumwm";
            extensionUuid = "albumwm@0iq.dev";
          };
        };

        # This allows us to build Qemu for the host system thus avoiding
        # double emulation
        packages.vm =
          let
            hostConfig = self.nixosConfigurations.testbox;
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
      }
    )
    // {
      nixosConfigurations."testbox" =
        let
          system = "x86_64-linux";
          pkgs-gnome = import nixpkgs-gnome { inherit system; };
        in
        nixpkgs.lib.nixosSystem {
          inherit system;
          modules = [
            (
              { pkgs, lib, ... }:
              {
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

                # Pull GNOME-specific packages from GNOME staging
                (s: super: {
                  gnome-desktop = pkgs-gnome.gnome-desktop;
                  gnome-shell = pkgs-gnome.gnome-shell.override {
                    evolution-data-server-gtk4 = super.evolution-data-server-gtk4.override {
                      inherit (super) webkitgtk_4_1 webkitgtk_6_0;
                    };
                  };
                  gnome-session = pkgs-gnome.gnome-session.override {
                    inherit (s) gnome-shell;
                  };
                  gnome-control-center = pkgs-gnome.gnome-control-center;
                  gnome-initial-setup = pkgs-gnome.gnome-initial-setup.override {
                    inherit (super) webkitgtk_6_0;
                  };
                  gnome-settings-daemon = pkgs-gnome.gnome-settings-daemon;
                  mutter = pkgs-gnome.mutter;
                  gdm = pkgs-gnome.gdm;
                  xdg-desktop-portal-gnome = pkgs-gnome.xdg-desktop-portal-gnome;
                  xdg-desktop-portal-gtk = pkgs-gnome.xdg-desktop-portal-gtk;
                })
              ];
            }
          ];
        };
    };
}
