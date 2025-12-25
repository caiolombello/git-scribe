PREFIX ?= $(HOME)/.local
CONFIG_DIR ?= $(HOME)/.config/git-scribe
CONFIG_FILE ?= $(CONFIG_DIR)/config.json

build:
	bun run build

install: build
	install -d "$(PREFIX)/bin"
	printf '%s\n' '#!/usr/bin/env bun' > "$(PREFIX)/bin/git-scribe"
	cat dist/cli.js >> "$(PREFIX)/bin/git-scribe"
	chmod 755 "$(PREFIX)/bin/git-scribe"
	install -d "$(CONFIG_DIR)"
	@if [ ! -f "$(CONFIG_FILE)" ]; then \
		printf '%s\n' '{' > "$(CONFIG_FILE)"; \
		printf '%s\n' '  "apiKey": "",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "model": "gpt-5.1-codex-mini",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "baseUrl": "https://api.openai.com",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "language": ""' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '}' >> "$(CONFIG_FILE)"; \
		echo "Config file created at $(CONFIG_FILE)"; \
	fi

uninstall:
	rm -f "$(PREFIX)/bin/git-scribe"
