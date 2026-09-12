.PHONY: dev check test lint typecheck build train sync-history collect collection-status
dev:
	uv run --env-file .env observatory serve --reload
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
	uv run --env-file .env --extra ml observatory train
sync-history:
	uv run --env-file .env observatory sync-history
collect:
	uv run --env-file .env observatory collect
collection-status:
	uv run --env-file .env observatory collection-status
