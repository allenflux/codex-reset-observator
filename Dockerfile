FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md LICENSE requirements.txt ./
COPY observatory ./observatory
RUN pip install --no-cache-dir --require-hashes -r requirements.txt && pip install --no-cache-dir --no-deps . && useradd --create-home observatory && mkdir -p /app/var && chown observatory /app/var
USER observatory
ENV DATABASE_PATH=/app/var/observatory.sqlite3
EXPOSE 8000
VOLUME ["/app/var"]
CMD ["uvicorn", "observatory.app:app", "--host", "0.0.0.0", "--port", "8000"]
