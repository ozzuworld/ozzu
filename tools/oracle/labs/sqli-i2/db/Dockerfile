FROM postgres:16-alpine
ENV POSTGRES_DB=appdb POSTGRES_USER=webuser POSTGRES_PASSWORD=webpass
COPY init.sql /docker-entrypoint-initdb.d/init.sql
