# Company Brain Project Makefile
# Root task runner for development, build, lint, typecheck, test, and migration

# Note: 'test:e2e' is intentionally absent from .PHONY — GNU Make 3.81
# (shipped with macOS) rejects colons inside .PHONY target lists.
.PHONY: help tasks dev build lint typecheck test test\:e2e migrate helm-validate clean

# Variables
# PROCESSES selects which processes to boot (see server/src/bootstrap.ts).
# Empty = all processes in one process (development only); production requires
# an explicit list.
PROCESSES ?= api,mcp,crawler,ingestion-worker,github-sync-worker,temporal-worker

help:
	@echo "Available tasks:"
	@echo "  dev           - Start all services (default)"
	@echo "  build         - Build all packages"
	@echo "  lint          - Run linting"
	@echo "  typecheck     - Run type checking"
	@echo "  test          - Run unit tests"
	@echo "  test:e2e      - Run end-to-end tests"
	@echo "  migrate       - Apply database migrations"
	@echo "  helm-validate - Lint and render the Helm chart"
	@echo "  clean         - Clean build artifacts"
	@echo ""
	@echo "Processes: api, mcp, crawler, ingestion-worker, github-sync-worker, temporal-worker"
	@echo "Example: make dev PROCESSES=api,mcp"

# Default target
tasks:
	@echo "Available tasks:"
	@echo "  dev           - Start all services (default)"
	@echo "  build         - Build all packages"
	@echo "  lint          - Run linting"
	@echo "  typecheck     - Run type checking"
	@echo "  test          - Run unit tests"
	@echo "  test:e2e      - Run end-to-end tests"
	@echo "  migrate       - Apply database migrations"
	@echo "  helm-validate - Lint and render the Helm chart"
	@echo "  clean         - Clean build artifacts"

dev:
	@echo "Starting Company Brain services..."
	@if [ -z "$(PROCESSES)" ]; then \
		echo "ERROR: PROCESSES environment variable is required"; \
		echo "Example: make dev PROCESSES=api,mcp,crawler,ingestion-worker,temporal-worker"; \
		exit 1; \
	fi
	npm run --prefix server build
	npm run --prefix client build
	PROCESSES=$(PROCESSES) node server/dist/bootstrap.js

build:
	npm run --prefix server build
	npm run --prefix client build

lint:
	npm run --prefix client lint
	npm run --prefix server lint

typecheck:
	npm run --prefix server typecheck
	npm run --prefix client typecheck

test:
	npm run --prefix server test

# Escaped colon: GNU Make 3.81 parses a bare `test:e2e:` as a static pattern
# rule; `test\:e2e:` makes the colon part of the target name.
test\:e2e:
	npm run --prefix server test:e2e

migrate:
	npm run --prefix server migrate

helm-validate:
	helm lint deploy/helm/company-brain
	helm template company-brain deploy/helm/company-brain >/dev/null

clean:
	rm -rf dist server/dist client/dist
	npm run --prefix server clean
	npm run --prefix client clean