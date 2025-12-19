PREFIX ?= $(HOME)/.local

build:
	bun run build

install: build
	install -d "$(PREFIX)/bin"
	printf '%s\n' '#!/usr/bin/env bun' > "$(PREFIX)/bin/git-scribe"
	cat dist/cli.js >> "$(PREFIX)/bin/git-scribe"
	chmod 755 "$(PREFIX)/bin/git-scribe"

uninstall:
	rm -f "$(PREFIX)/bin/git-scribe"
