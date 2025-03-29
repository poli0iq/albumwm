{ pkgs, config, lib, ... }:

{
  ### Make PaperWM available in system environment
  environment.systemPackages = with pkgs;
  [ paperwm
    (lib.getBin libinput)
  ];

  ### Set graphical session to auto-login GNOME
  services.xserver =
  { enable = true;
    displayManager.autoLogin =
    { enable = true;
      user = "user";
    };
    displayManager.gdm.enable = true;
    desktopManager.gnome.enable = true;
  };

  ### Set dconf to enable PaperWM out of the box
  programs.dconf =
  { enable = true;
    profiles."user".databases = [
      { settings =
        { "org/gnome/shell" =
          { enabled-extensions = [ "paperwm@paperwm.github.com" ];
            disable-user-extensions = false;
          };
        };
        #NOTE: You can add more dconf settings to test with here!
      }
    ];
  };

  ### Remove unnecessary dependencies
  #NOTE: This drops many GTK4 apps, re-enable if needed for testing.
  services.gnome.core-utilities.enable = false;

  ### Set default user
  users.users."user" =
  { isNormalUser = true;
    createHome = true;
    home = "/home";
    description = "PaperWM test user";
    extraGroups = [ "wheel" ];
    password = "paperwm";
  };

  ### No-password sudo
  security.sudo =
  { enable = true;
    extraConfig = "%wheel ALL=(ALL) NOPASSWD: ALL";
  };
}
