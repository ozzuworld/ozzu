FROM python:3.11-slim

WORKDIR /app

# System deps for opencv + build tools for insightface C++ extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 g++ && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py model.py ./

EXPOSE 5555

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5555"]
