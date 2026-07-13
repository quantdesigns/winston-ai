.PHONY: build run dev frontend all clean deps install-services uninstall-services test test-unit test-security test-cover lint

# Build the Go router
build:
	go build -o bin/winston ./cmd/winston

# Run the Go router
run: build
	./bin/winston

# Run Go router in dev mode with hot reload (requires air)
dev:
	air -c .air.toml || go run ./cmd/winston

# Run the Next.js frontend
frontend:
	cd web && npm run dev

# Run both router and frontend
all:
	@echo "Starting Winston..."
	@make run &
	@make frontend

# Clean build artifacts
clean:
	rm -rf bin/
	rm -rf web/.next/

# Install dependencies
deps:
	go mod tidy
	cd web && npm install

# Install background services (macOS launchd or Linux systemd)
install-services: build
	@bash scripts/install-services.sh

# Uninstall background services
uninstall-services:
	@bash scripts/uninstall-services.sh

# Run all tests
test:
	go test -v -race -count=1 ./internal/...

# Run unit tests only (excludes Security and Integration prefixed tests)
test-unit:
	go test -v -race -run 'Test[^S][^e][^c]' ./internal/...

# Run security tests only
test-security:
	go test -v -race -run TestSecurity ./internal/...

# Run tests with coverage report
test-cover:
	go test -coverprofile=coverage.out -covermode=atomic ./internal/...
	go tool cover -func=coverage.out
	@echo ""
	@echo "HTML report: go tool cover -html=coverage.out"

# Run Go linter
lint:
	go vet ./...
	@which golangci-lint > /dev/null 2>&1 && golangci-lint run || echo "Install golangci-lint for full linting"
