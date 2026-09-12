FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.txt
COPY pyproject.toml README.md LICENSE ./
COPY observatory ./observatory
RUN python -m pip install --no-cache-dir --no-deps . \
    && useradd --create-home observatory \
    && mkdir -p /app/var \
    && chown observatory /app/var

USER observatory
ENV DATABASE_PATH=/app/var/observatory.sqlite3
EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import json, urllib.request; response = urllib.request.urlopen('http://127.0.0.1:9090/healthz', timeout=5); raise SystemExit(0 if response.status == 200 and json.load(response).get('status') == 'ok' else 1)"

CMD ["observatory", "serve", "--host", "0.0.0.0", "--port", "9090"]
