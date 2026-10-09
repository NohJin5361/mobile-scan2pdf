# Scan2PDF server + web app. OCR (Korean + English) included.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server server
COPY web web

ENV SCAN2PDF_DATA_DIR=/data
VOLUME /data
EXPOSE 8000
WORKDIR /app/server
CMD ["python", "-m", "scan2pdf", "--host", "0.0.0.0", "--port", "8000"]
