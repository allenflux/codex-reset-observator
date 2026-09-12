.PHONY: dev check test lint typecheck build train sync-history collect collection-status ios-test ios-build
IOS_DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
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
ios-test:
	DEVELOPER_DIR="$(IOS_DEVELOPER_DIR)" swift test --package-path ios --scratch-path var/ios-tests
ios-build:
	DEVELOPER_DIR="$(IOS_DEVELOPER_DIR)" xcodebuild -project ios/ResetObservatory.xcodeproj -scheme ResetObservatory -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath var/ios-device CODE_SIGNING_ALLOWED=NO build
