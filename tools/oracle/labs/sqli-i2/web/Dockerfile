FROM python:3.11-slim
RUN pip install --no-cache-dir flask psycopg2-binary
COPY app.py /app/app.py
WORKDIR /app
EXPOSE 80
CMD ["python", "app.py"]
