FROM python:3.11-slim
RUN pip install --no-cache-dir flask requests
COPY app.py internal.py start.sh /app/
WORKDIR /app
RUN chmod +x start.sh
EXPOSE 80
CMD ["/app/start.sh"]
