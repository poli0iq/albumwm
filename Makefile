NAME = albumwm
DOMAIN = 0iq.dev
UUID = $(NAME)@$(DOMAIN)

SOURCES := $(wildcard *.js *.ts) \
           $(shell find preferences wm -type f \( -name '*.js' -o -name '*.ts' \))

STATIC_DIST := dist/schemas dist/ui dist/resources dist/config \
               dist/metadata.json dist/stylesheet.css dist/LICENSE

.PHONY: all pack install uninstall clean

all: dist/extension.js $(STATIC_DIST)

node_modules/.package-lock.json: package.json
	npm install

dist/extension.js: node_modules/.package-lock.json tsconfig.json $(SOURCES)
	rm -rf dist
	npm run build

schemas/gschemas.compiled: schemas/org.gnome.shell.extensions.$(NAME).gschema.xml
	glib-compile-schemas schemas

.SECONDEXPANSION:
$(STATIC_DIST): dist/%: dist/extension.js % $$(wildcard $$*/*)
	rm -rf $@
	cp -r $* dist/

dist/schemas: schemas/gschemas.compiled

$(UUID).zip: $(STATIC_DIST)
	rm -f $@
	(cd dist && zip ../$@ -9r .)

pack: $(UUID).zip

install: $(UUID).zip
	gnome-extensions install --force $(UUID).zip

uninstall:
	rm -rf $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

clean:
	@rm -rf dist node_modules $(UUID).zip
