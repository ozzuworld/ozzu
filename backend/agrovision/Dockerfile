FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi==0.115.* \
    uvicorn[standard]==0.34.* \
    onnxruntime==1.21.* \
    qdrant-client==1.17.* \
    numpy==2.* \
    Pillow==11.* \
    python-multipart==0.0.*

COPY server.py .
COPY disease_metadata.json .

EXPOSE 5556

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5556", "--workers", "1"]
