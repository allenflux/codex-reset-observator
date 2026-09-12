.PHONY: dev check test lint typecheck build train sync-history
dev:
	uv run observatory serve --reload
test:
	uv run --extra ml pytest -m 'not browser'
lint:
	uv run ruff check observatory tests_python
typecheck:
	uv run mypy observatory
build:
	uv build
check: lint typecheck test build
train:
	uv run --extra ml observatory train
sync-history:
	uv run observatory sync-history
