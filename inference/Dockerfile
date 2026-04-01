# Stage 1: Builder — export HF models to ONNX
FROM python:3.11-slim AS builder

RUN pip install --no-cache-dir \
    "optimum[onnxruntime]" \
    transformers \
    tokenizers

RUN python3 -c "\
from optimum.onnxruntime import ORTModelForFeatureExtraction; \
from transformers import AutoTokenizer; \
model = ORTModelForFeatureExtraction.from_pretrained('BAAI/bge-small-en-v1.5', export=True); \
tokenizer = AutoTokenizer.from_pretrained('BAAI/bge-small-en-v1.5'); \
model.save_pretrained('/models/embed'); \
tokenizer.save_pretrained('/models/embed')"

RUN python3 -c "\
from optimum.onnxruntime import ORTModelForSequenceClassification; \
from transformers import AutoTokenizer; \
model = ORTModelForSequenceClassification.from_pretrained('MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli', export=True); \
tokenizer = AutoTokenizer.from_pretrained('MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli'); \
model.save_pretrained('/models/nli'); \
tokenizer.save_pretrained('/models/nli')"

# Stage 2: Runtime — inference only, no optimum or PyTorch
FROM python:3.11-slim AS runtime

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY --from=builder /models /models
COPY main.py /app/main.py

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false \
    OMP_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "8"]
