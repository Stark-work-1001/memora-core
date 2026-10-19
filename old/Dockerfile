# Same focused MCP application; data is mounted separately.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MEMORA_DATA=/data
RUN useradd --create-home --uid 10001 memora && mkdir /data && chown memora /data
WORKDIR /app
COPY requirements-lock.txt .
RUN pip install --no-cache-dir -r requirements-lock.txt
COPY pyproject.toml README.md LICENSE NOTICE ./
COPY LICENSES ./LICENSES
COPY memora ./memora
COPY memory_merge ./memory_merge
RUN pip install --no-cache-dir --no-deps .
USER memora
VOLUME ["/data"]
ENTRYPOINT ["memora-mcp"]
