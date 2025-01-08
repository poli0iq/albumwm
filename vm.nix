{ pkgs, config, lib, ... }:

{
  ### Make PaperWM available in system environment
  environment.systemPackages = with pkgs;
  [ paperwm
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
          };
        };
      }
    ];
  };

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
