# ── Eco AI service image ─────────────────────────────────────────────────────
# numpy, pandas, scikit-learn and statsmodels carry substantial build
# toolchains. Compiling in a builder stage and copying only the installed
# packages forward keeps ~400MB of gcc and headers out of the runtime image.

FROM python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential gfortran \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip \
 && /opt/venv/bin/pip install -r requirements.txt

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS production

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# libgomp is required at runtime by scikit-learn's OpenMP kernels.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/bash eco

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=eco:eco app ./app

USER eco
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/health/live || exit 1

# One worker per container: horizontal scaling is Kubernetes' job, and multiple
# workers behind a single probe hides a wedged process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
