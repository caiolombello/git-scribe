PREFIX ?= $(HOME)/.local
CONFIG_DIR ?= $(HOME)/.config/git-scribe
CONFIG_FILE ?= $(CONFIG_DIR)/config.json
BUILD_TARGET ?= node
RUNTIME ?= node

build:
	bun run build:$(BUILD_TARGET)

install: build
	install -d "$(PREFIX)/bin"
	printf '%s\n' '#!/usr/bin/env $(RUNTIME)' > "$(PREFIX)/bin/git-scribe"
	cat dist/cli.js >> "$(PREFIX)/bin/git-scribe"
	chmod 755 "$(PREFIX)/bin/git-scribe"
	install -d "$(CONFIG_DIR)"
	@if [ ! -f "$(CONFIG_FILE)" ]; then \
		printf '%s\n' '{' > "$(CONFIG_FILE)"; \
		printf '%s\n' '  "apiKey": "",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "model": "gpt-5.1-codex-mini",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "baseUrl": "https://api.openai.com",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "language": "",' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "retry": { "maxRetries": 3, "baseDelay": 1000, "maxDelay": 30000, "timeout": 60000 },' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "cache": { "maxAgeDays": 14, "maxEntries": 200 },' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "grouping": { "maxFilesForAi": 30, "maxFilesPerGroup": 25 },' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "ui": { "pageSize": 12 },' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '  "debug": false' >> "$(CONFIG_FILE)"; \
		printf '%s\n' '}' >> "$(CONFIG_FILE)"; \
		echo "Config file created at $(CONFIG_FILE)"; \
	fi

uninstall:
	rm -f "$(PREFIX)/bin/git-scribe"
