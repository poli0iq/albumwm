{ pkgs, stdenv, glib, ... }:

let
  uuid = "albumwm@0iq.dev";
in
stdenv.mkDerivation {
  pname = "gnome-shell-extension-albumwm";
  version = "unstable";
  src = ./.;

  makeFlags = [ "SOURCE=$(src)" "EXT_DIR=$(out)/share/gnome-shell/extensions" ];

  nativeBuildInputs = with pkgs;
    [ glib
    ];

  passthru = {
    extensionPortalSlug = "albumwm";
    extensionUuid = uuid;
  };
}
