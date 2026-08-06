# Company Brain Project Makefile
# Root task runner for development, build, lint, typecheck, test, and migration

.PHONY: help tasks dev build lint typecheck test test:e2e migrate clean

# Variables
PROCESSES ?= api,mcp,crawler,ingestion-worker,temporal-worker

help:
	@echo "Available tasks:"
	@echo "  dev           - Start all services (default)"
	@echo "  build         - Build all packages"
	@echo "  lint          - Run linting"
	@echo "  typecheck     - Run type checking"
	@echo "  test          - Run unit tests"
	@echo "  test:e2e      - Run end-to-end tests"
	@echo "  migrate       - Apply database migrations"
	@echo "  clean         - Clean build artifacts"

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
	PROCESSES=$(PROCESSES) node --loader ts-node/esm --experimental-specifier-resolution=node server/src/index.js

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

test:e2e:
	npm run --prefix server test:e2e

migrate:
	npm run --prefix server migrate

clean:
	rm -rf dist server/dist client/dist
	npm run --prefix server clean
	npm run --prefix client clean